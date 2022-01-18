import accountgrpcv4 from "@kin-beta/agora-api/node/account/v4/account_service_grpc_pb";
import airdropgrpcv4 from "@kin-beta/agora-api/node/airdrop/v4/airdrop_service_grpc_pb";
import commonpb from "@kin-beta/agora-api/node/common/v3/model_pb";
import transactiongrpcv4 from "@kin-beta/agora-api/node/transaction/v4/transaction_service_grpc_pb";
import transactionpbv4 from "@kin-beta/agora-api/node/transaction/v4/transaction_service_pb";
import { ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Account as SolanaAccount, PublicKey as SolanaPublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import hash from "hash.js";
import LRUCache from 'lru-cache';
import {
    AccountResolution,
    bigNumberToU64,
    Commitment,
    EarnBatch,
    EarnBatchResult,
    EarnError,
    Environment,
    invoiceToProto,
    Memo as KinMemo,
    Payment,
    PrivateKey,
    PublicKey,
    TransactionData,
    TransactionType
} from "../";
import { AccountDoesNotExist, AlreadyPaid, BadNonce, invoiceErrorFromProto, nonRetriableErrors as nonRetriableErrorList, NoSubsidizerError, PayerRequired, SkuNotFound, TransactionRejected, WrongDestination } from "../errors";
import { backoffWithJitter, binaryExpotentialDelay, limit, nonRetriableErrors, retriableErrors, retryAsync } from "../retry";
import { MemoProgram } from "../solana/memo-program";
import { AccountSize } from "../solana/token-program";
import { InternalClient, SubmitTransactionResult } from "./";
import { InternalClientConfig } from "./internal";


export interface ClientConfig {
    endpoint?:        string
    internal?:        InternalClient
    accountClientV4?: accountgrpcv4.AccountClient
    airdropClientV4?: airdropgrpcv4.AirdropClient
    txClientV4?:      transactiongrpcv4.TransactionClient

    appIndex?: number
    retryConfig?: RetryConfig

    // The default commitment to use for Solana requests. Only relevant for Kin 4.
    // Defaults to Commitment.Single.
    defaultCommitment?: Commitment
}

export interface RetryConfig {
    maxRetries:        number
    minDelaySeconds:   number
    maxDelaySeconds:   number
    maxNonceRefreshes: number
}

const defaultRetryConfig: RetryConfig = {
    maxRetries: 5,
    minDelaySeconds: 0.5,
    maxDelaySeconds: 10,
    maxNonceRefreshes: 3,
};

const MAX_BATCH_SIZE = 15;

// Client is the primary class that should be used for interacting with kin.
//
// Client abstracts away the underlying blockchain implementations, allowing for
// easier upgrades in the future.
export class Client {
    internal:           InternalClient;
    retryConfig: RetryConfig;

    appIndex?:          number;
    env:                Environment;
    issuer?:            string;
    defaultCommitment:  Commitment;
    accountCache:       LRUCache<string, string>;


    constructor(env: Environment, conf?: ClientConfig) {
        if (conf?.endpoint) {
            if (conf?.internal) {
                throw new Error("cannot specify both endpoint and internal client");
            }
            if (conf?.accountClientV4 || conf?.airdropClientV4 || conf?.txClientV4) {
                throw new Error("cannot specify both endpoint and gRPC clients");
            }
        } else if (conf?.internal) {
            if (conf?.accountClientV4 || conf?.airdropClientV4 || conf?.txClientV4) {
                throw new Error("cannot specify both internal and gRPC clients");
            }
        } else if (
            (conf?.accountClientV4 == undefined) !== (conf?.airdropClientV4 == undefined) ||
            (conf?.accountClientV4 == undefined) !== (conf?.txClientV4 == undefined)
        ) {
            throw new Error("either all or none of the gRPC clients must be set");
        }

        let defaultEndpoint: string;
        switch (env) {
            case Environment.Test:
                defaultEndpoint = "api.agorainfra.dev:443";
                break;
            case Environment.Prod:
                defaultEndpoint = "api.agorainfra.net:443";
                break;
            default:
                throw new Error("unsupported env:" + env);
        }
        this.env = env;

        if (conf) {
            this.appIndex = conf.appIndex;
        }

        this.retryConfig = defaultRetryConfig;
        if (conf?.retryConfig?.maxRetries) {
            this.retryConfig.maxRetries = conf?.retryConfig?.maxRetries;
        }
        if (conf?.retryConfig?.minDelaySeconds) {
            this.retryConfig.minDelaySeconds = conf?.retryConfig?.minDelaySeconds;
        }
        if (conf?.retryConfig?.maxDelaySeconds) {
            this.retryConfig.maxDelaySeconds = conf?.retryConfig?.maxDelaySeconds;
        }
        if (conf?.retryConfig?.maxNonceRefreshes) {
            this.retryConfig.maxNonceRefreshes = conf?.retryConfig?.maxNonceRefreshes;
        }

        if (conf?.defaultCommitment !== undefined) {
            this.defaultCommitment = conf?.defaultCommitment;
        } else {
            this.defaultCommitment = Commitment.Single;
        }
        this.accountCache = new LRUCache({
            max: 500,
            maxAge: 5 * 60 * 1000,  // 5 minutes
        });
        if (conf?.internal) {
            this.internal = conf.internal;
            return;
        }

        const internalConf: InternalClientConfig = {
            endpoint: conf?.endpoint,
            accountClientV4: conf?.accountClientV4,
            airdropClientV4: conf?.airdropClientV4,
            txClientV4: conf?.txClientV4,
            appIndex: conf?.appIndex,
        };
        if (!internalConf.endpoint && !internalConf.accountClientV4 && !internalConf.endpoint) {
            internalConf.endpoint = defaultEndpoint;
        }

        let retryConfig: RetryConfig = Object.assign({}, defaultRetryConfig);
        if (conf && conf.retryConfig) {
            retryConfig = conf.retryConfig!;
        }
        internalConf.strategies = [
            nonRetriableErrors(...nonRetriableErrorList),
            limit(retryConfig.maxRetries),
            backoffWithJitter(binaryExpotentialDelay(retryConfig.minDelaySeconds), retryConfig.maxDelaySeconds, 0.1),
        ];

        this.internal = new InternalClient(internalConf);
    }

    // createAccount creates a new Kin account.
    //
    // Promise.reject(new AccountExists()) is called if
    // the account already exists.
    async createAccount(key: PrivateKey, commitment: Commitment = this.defaultCommitment, subsidizer?: PrivateKey): Promise<void> {
        return retryAsync(async() => {
            return this.internal.createAccount(key, commitment, subsidizer);
        }, limit(this.retryConfig.maxNonceRefreshes), retriableErrors(BadNonce));
    }

    // getBalance retrieves the balance for an account.
    //
    // Promise.reject(new AccountDoesNotExist()) is called if
    // the specified account does not exist.
    async getBalance(account: PublicKey, commitment: Commitment = this.defaultCommitment, accountResolution: AccountResolution = AccountResolution.Preferred): Promise<BigNumber> {
        return this.internal.getAccountInfo(account, commitment)
            .then(info => new BigNumber(info.getBalance()))
            .catch(err => {
                if (err instanceof AccountDoesNotExist) {
                    if (accountResolution == AccountResolution.Preferred) {
                        return this.internal.resolveTokenAccounts(account, true)
                            .then(accountInfos => {
                                if (accountInfos.length > 0) {
                                    return Promise.resolve(new BigNumber(accountInfos[0].getBalance()));
                                }

                                return Promise.reject(err);
                            });
                    }
                }
                return Promise.reject(err);
            });
    }

    // resolveTokenAccounts resolves the token accounts ovned by the specified account on kin 4.
    async resolveTokenAccounts(account: PublicKey): Promise<PublicKey[]> {
        return this.internal.resolveTokenAccounts(account, false)
            .then(accountInfos => accountInfos.map(info => new PublicKey(info.getAccountId()!.getValue_asU8())))
            .catch(err => {
                return Promise.reject(err);
            });
    }

    async mergeTokenAccounts(key: PrivateKey, createAssociatedAccount: boolean, commitment: Commitment = this.defaultCommitment, subsidizer?: PrivateKey): Promise<Buffer|undefined> {
        const existingAccounts = await this.internal.resolveTokenAccounts(key.publicKey(), true);
        const owner = key.publicKey().solanaKey();

        if (existingAccounts.length === 0 || (!createAssociatedAccount && existingAccounts.length === 1)) {
            return Promise.resolve(undefined);
        }

        let dest = new SolanaPublicKey(Buffer.from(existingAccounts[0].getAccountId()!.getValue_asU8()));

        const signers = [key];
        let subsidizerId: SolanaPublicKey;

        const config = await this.internal.getServiceConfig();
        if (!config.getSubsidizerAccount() && !subsidizer) {
            return Promise.reject(new NoSubsidizerError());
        }

        const mint = new SolanaPublicKey(Buffer.from(config.getToken()!.getValue_asU8()));
        if (subsidizer) {
            subsidizerId = subsidizer.publicKey().solanaKey();
            signers.push(subsidizer);
        } else {
            subsidizerId = new SolanaPublicKey(Buffer.from(config.getSubsidizerAccount()!.getValue_asU8()));
        }

        const instructions = [];
        if (createAssociatedAccount) {
            const assoc = await Token.getAssociatedTokenAddress(
                ASSOCIATED_TOKEN_PROGRAM_ID,
                TOKEN_PROGRAM_ID,
                mint,
                owner,
            );

            if (!Buffer.from(existingAccounts[0].getAccountId()!.getValue_asU8()).equals(assoc.toBuffer())) {
                instructions.push(Token.createAssociatedTokenAccountInstruction(
                    ASSOCIATED_TOKEN_PROGRAM_ID,
                    TOKEN_PROGRAM_ID,
                    mint,
                    assoc,
                    owner,
                    subsidizerId
                ));
                instructions.push(Token.createSetAuthorityInstruction(
                    TOKEN_PROGRAM_ID,
                    assoc,
                    subsidizerId,
                    'CloseAccount',
                    owner,
                    [],
                ));
                dest = assoc;
            } else if (existingAccounts.length === 1) {
                return Promise.resolve(undefined);
            }
        }

        for(let i = 0; i < existingAccounts.length; i++) {
            const existingAccount = existingAccounts[i];
            if (Buffer.from(existingAccount.getAccountId()!.getValue_asU8()).equals(dest.toBuffer())) {
                continue;
            }

            instructions.push(Token.createTransferInstruction(
                TOKEN_PROGRAM_ID,
                new SolanaPublicKey(existingAccount.getAccountId()!.getValue_asU8()),
                dest,
                owner,
                [],
                bigNumberToU64(new BigNumber(existingAccount.getBalance()))),
            );

            // If no close authority is set, it likely means we do not know it and can't make any assumptions
            const closeAuth = existingAccount.getCloseAuthority();
            if (!closeAuth) {
                continue;
            }

            const closeableAuths = [key.publicKey().buffer, subsidizerId.toBuffer()];
            let shouldClose = false;
            for(let i = 0; i < closeableAuths.length; i++) {
                if (closeableAuths[i].equals(Buffer.from(closeAuth.getValue_asU8()))) {
                    shouldClose = true;
                    break;
                }
            }

            if (shouldClose) {
                instructions.push(Token.createCloseAccountInstruction(
                    TOKEN_PROGRAM_ID,
                    new SolanaPublicKey(existingAccount.getAccountId()!.getValue_asU8()),
                    new SolanaPublicKey(closeAuth.getValue_asU8()),
                    new SolanaPublicKey(closeAuth.getValue_asU8()),
                    [],
                ));
            }
        }

        const tx = new Transaction({
            feePayer: subsidizerId,
        }).add(...instructions);

        const result = await this.signAndSubmitTx(signers, tx, commitment);
        if (result.Errors && result.Errors?.TxError) {
            return Promise.reject(result.Errors.TxError);
        }

        return result.TxId;
    }

    // getTransaction retrieves the TransactionData for a txId.
    //
    // If no transaction data currently exists, Promise.resolve(undefined)
    // is called. In this state, the transaction may or may not resolve in
    // the future, it is simply unknown _at this time_.
    async getTransaction(txId: Buffer, commitment: Commitment = this.defaultCommitment): Promise<TransactionData|undefined> {
        return this.internal.getTransaction(txId, commitment);
    }

    // submitPayment submits a payment.
    //
    // If the payment has an invoice, an app index _must_ be set.
    // If the payment has a memo, an invoice cannot also be provided.
    async submitPayment(
        payment: Payment, commitment: Commitment = this.defaultCommitment, senderResolution: AccountResolution = AccountResolution.Preferred,
        destinationResolution: AccountResolution = AccountResolution.Preferred, senderCreate = false,
    ): Promise<Buffer> {
        if (payment.invoice && !this.appIndex) {
            return Promise.reject("cannot submit payment with invoices without an app index");
        }

        const result = await this.submitPaymentWithResolution(payment, commitment, senderResolution, destinationResolution, senderCreate);
        if (result.Errors && result.Errors.PaymentErrors) {
            if (result.Errors.PaymentErrors.length != 1) {
                return Promise.reject(new Error("invalid number of payemnt errors. expected 0 or 1"));
            }

            return Promise.reject(result.Errors.PaymentErrors[0]);
        }
        if (result.Errors && result.Errors.TxError) {
            return Promise.reject(result.Errors.TxError);
        }
        if (result.InvoiceErrors && result.InvoiceErrors.length > 0) {
            if (result.InvoiceErrors.length != 1) {
                return Promise.reject(new Error("invalid number of invoice errors. expected 0 or 1"));
            }

            switch (result.InvoiceErrors[0].getReason()) {
                case commonpb.InvoiceError.Reason.ALREADY_PAID:
                    return Promise.reject(new AlreadyPaid());
                case commonpb.InvoiceError.Reason.WRONG_DESTINATION:
                    return Promise.reject(new WrongDestination());
                case commonpb.InvoiceError.Reason.SKU_NOT_FOUND:
                    return Promise.reject(new SkuNotFound());
                default:
                    return Promise.reject(new Error("unknown invoice error"));
            }
        }

        return Promise.resolve(result.TxId);
    }

    // submitEarnBatch submits a batch of earns in a single transaction.
    //
    // EarnBatch is limited to 15 earns, which is roughly the max number of
    // transfers that can fit inside a Solana transaction.
    async submitEarnBatch(
        batch: EarnBatch, commitment: Commitment = this.defaultCommitment, senderResolution: AccountResolution = AccountResolution.Preferred,
        destinationResolution: AccountResolution = AccountResolution.Preferred
    ): Promise<EarnBatchResult> {
        if (batch.earns.length === 0) {
            return Promise.reject(new Error("An EarnBatch must contain at least 1 earn."));
        }

        if (batch.earns.length > MAX_BATCH_SIZE) {
            return Promise.reject(new Error(`An EarnBatch must not contain more than ${MAX_BATCH_SIZE} earns.`));
        }

        if (batch.memo) {
            for (const r of batch.earns) {
                if (r.invoice) {
                    return Promise.reject(new Error("cannot have invoice set when memo is set"));
                }
            }
        } else {
            if (batch.earns[0].invoice && !this.appIndex) {
                return Promise.reject(new Error("cannot submit earn batch without an app index"));
            }

            for (let i = 0; i < batch.earns.length - 1; i++) {
                if ((batch.earns[i].invoice == undefined) != (batch.earns[i+1].invoice == undefined)) {
                    return Promise.reject(new Error("either all or none of the earns should have an invoice set"));
                }
            }
        }

        const config = await this.internal.getServiceConfig();
        if (!config.getSubsidizerAccount() && !batch.subsidizer) {
            return Promise.reject(new NoSubsidizerError());
        }
        const submitResult = await this.submitEarnBatchWithResolution(batch, config, commitment, senderResolution, destinationResolution);

        const result: EarnBatchResult = {
            txId: submitResult.TxId,
        };
        if (submitResult.Errors) {
            result.txError = submitResult.Errors.TxError;

            if (submitResult.Errors.PaymentErrors && submitResult.Errors.PaymentErrors.length > 0) {
                result.earnErrors = new Array<EarnError>();
                submitResult.Errors.PaymentErrors.forEach((error, i) => {
                    if (error) {
                        result.earnErrors!.push({
                            error: error,
                            earnIndex: i,
                        });
                    }
                });
            }
        }
        else if (submitResult.InvoiceErrors && submitResult.InvoiceErrors.length > 0) {
            result.txError = new TransactionRejected();
            result.earnErrors = new Array<EarnError>(submitResult.InvoiceErrors.length);
            submitResult.InvoiceErrors!.forEach((invoiceError, i) => {
                result.earnErrors![i] = {
                    error: invoiceErrorFromProto(invoiceError),
                    earnIndex: invoiceError.getOpIndex(),
                };
            });
        }

        return Promise.resolve(result);
    }

    // requestAirdrop requests an airdrop of Kin to a Kin account. Only available on Kin 4 on the test environment.
    async requestAirdrop(publicKey: PublicKey, quarks: BigNumber, commitment: Commitment = this.defaultCommitment): Promise<Buffer> {
        if (this.env !== Environment.Test) {
            return Promise.reject("`requestAirdrop` is only available on the test environment");
        }

        return this.internal.requestAirdrop(publicKey, quarks, commitment);
    }

    private async submitPaymentWithResolution(
        payment: Payment, commitment: Commitment, senderResolution: AccountResolution, destinationResolution: AccountResolution,
        senderCreate: boolean,
    ): Promise<SubmitTransactionResult> {
        const config = await this.internal.getServiceConfig();
        if (!config.getSubsidizerAccount() && !payment.subsidizer) {
            return Promise.reject(new NoSubsidizerError());
        }

        const subsidizerId = payment.subsidizer ? payment.subsidizer!.publicKey().solanaKey() : new SolanaPublicKey(config.getSubsidizerAccount()!.getValue_asU8());
        const mint = new SolanaPublicKey(config.getToken()!.getValue_asU8());

        let result = await this.submitPaymentTx(payment, config, commitment);
        if (result.Errors && result.Errors.TxError instanceof AccountDoesNotExist) {
            let transferSender: PublicKey | undefined = undefined;
            let resubmit = false;
            let createSigner: PrivateKey | undefined;
            let createInstructions: TransactionInstruction[] | undefined;

            if (senderResolution == AccountResolution.Preferred) {
                const tokenAccounts = await this.resolveTokenAccounts(payment.sender.publicKey());
                if (tokenAccounts.length > 0) {
                    transferSender = tokenAccounts[0];
                    resubmit = true;
                }
            }

            if (destinationResolution == AccountResolution.Preferred) {
                const tokenAccounts = await this.resolveTokenAccounts(payment.destination);
                if (tokenAccounts.length > 0) {
                    payment.destination = tokenAccounts[0];
                    resubmit = true;
                } else if (senderCreate) {
                    const lamports = await this.internal.getMinimumBalanceForRentExemption();
                    const tempKey = PrivateKey.random();

                    const originalDest = payment.destination;
                    payment.destination = tempKey.publicKey();
                    createInstructions = [
                        SystemProgram.createAccount({
                            fromPubkey: subsidizerId,
                            newAccountPubkey: tempKey.publicKey().solanaKey(),
                            lamports: lamports,
                            space: AccountSize,
                            programId: TOKEN_PROGRAM_ID,
                        }),
                        Token.createInitAccountInstruction(
                            TOKEN_PROGRAM_ID,
                            mint,
                            tempKey.publicKey().solanaKey(),
                            tempKey.publicKey().solanaKey(),
                        ),
                        Token.createSetAuthorityInstruction(
                            TOKEN_PROGRAM_ID,
                            tempKey.publicKey().solanaKey(),
                            subsidizerId,
                            'CloseAccount',
                            tempKey.publicKey().solanaKey(),
                            [],
                        ),
                        Token.createSetAuthorityInstruction(
                            TOKEN_PROGRAM_ID,
                            tempKey.publicKey().solanaKey(),
                            originalDest.solanaKey(),
                            'AccountOwner',
                            tempKey.publicKey().solanaKey(),
                            [],
                        ),
                    ];

                    createSigner = tempKey;
                    resubmit = true;
                }

            }

            if (resubmit) {
                result = await this.submitPaymentTx(payment, config, commitment, transferSender, createInstructions, createSigner);
            }
        }

        return result;
    }

    private async submitPaymentTx(
        payment: Payment, config: transactionpbv4.GetServiceConfigResponse, commitment: Commitment, transferSender?: PublicKey,
        createInstructions?: TransactionInstruction[], createSigner?: PrivateKey,
    ): Promise<SubmitTransactionResult> {
        let subsidizerKey: SolanaPublicKey;
        let signers: PrivateKey[];
        if (payment.subsidizer) {
            subsidizerKey = payment.subsidizer!.publicKey().solanaKey();
            signers = [payment.subsidizer, payment.sender];
        } else {
            subsidizerKey = new SolanaPublicKey(Buffer.from(config.getSubsidizerAccount()!.getValue_asU8()));
            signers = [payment.sender];
        }

        if (createSigner) {
            signers.push(createSigner);
        }

        const instructions = [];
        let invoiceList: commonpb.InvoiceList | undefined = undefined;

        if (payment.memo) {
            instructions.push(MemoProgram.memo({data: payment.memo}));
        } else if (this.appIndex) {
            let fk = Buffer.alloc(29);

            if (payment.invoice) {
                invoiceList = new commonpb.InvoiceList();
                invoiceList.addInvoices(invoiceToProto(payment.invoice));

                const serialized = invoiceList.serializeBinary();
                fk = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex");
            }

            const kinMemo = KinMemo.new(1, payment.type, this.appIndex!, fk);
            instructions.push(MemoProgram.memo({data: kinMemo.buffer.toString("base64")}));
        }

        if (createInstructions) {
            instructions.push(...createInstructions);
        }

        let sender: PublicKey;
        if (transferSender) {
            sender = transferSender;
        } else {
            sender = payment.sender.publicKey();
        }

        instructions.push(Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            payment.destination.solanaKey(),
            payment.sender.publicKey().solanaKey(),
            [],
            bigNumberToU64(payment.quarks)
        ));

        const tx = new Transaction({
            feePayer: subsidizerKey,
        }).add(...instructions);

        return this.signAndSubmitTx(signers, tx, commitment, invoiceList, payment.dedupeId);
    }

    private async submitEarnBatchWithResolution(
        batch: EarnBatch, config: transactionpbv4.GetServiceConfigResponse,
        commitment: Commitment, senderResolution: AccountResolution = AccountResolution.Preferred,
        destinationResolution: AccountResolution = AccountResolution.Preferred
    ): Promise<SubmitTransactionResult> {
        let result = await this.submitEarnBatchTx(batch, config, commitment);
        if (result.Errors && result.Errors.TxError instanceof AccountDoesNotExist) {
            let transferSource: PublicKey | undefined = undefined;
            let resubmit = false;

            if (senderResolution == AccountResolution.Preferred) {
                const tokenAccounts = await this.resolveTokenAccounts(batch.sender.publicKey());
                if (tokenAccounts.length > 0) {
                    transferSource = tokenAccounts[0];
                    resubmit = true;
                }
            }

            if (destinationResolution == AccountResolution.Preferred) {
                for (let i = 0; i < batch.earns.length; i += 1) {
                    const tokenAccounts = await this.resolveTokenAccounts(batch.earns[i].destination);
                    if (tokenAccounts.length > 0) {
                        batch.earns[i].destination = tokenAccounts[0];
                        resubmit = true;
                    }
                }
            }

            if (resubmit) {
                result = await this.submitEarnBatchTx(batch, config, commitment, transferSource);
            }
        }

        return result;
    }

    private async submitEarnBatchTx(
        batch: EarnBatch, config: transactionpbv4.GetServiceConfigResponse, commitment: Commitment, transferSource?: PublicKey
    ): Promise<SubmitTransactionResult> {
        let subsidizerId: SolanaPublicKey;
        let signers: PrivateKey[];
        if (batch.subsidizer) {
            subsidizerId = batch.subsidizer!.publicKey().solanaKey();
            signers = [batch.subsidizer!, batch.sender];
        } else {
            subsidizerId = new SolanaPublicKey(config.getSubsidizerAccount()!.getValue_asU8());
            signers = [batch.sender];
        }

        let sender: PublicKey;
        if (transferSource) {
            sender = transferSource;
        } else {
            sender = batch.sender.publicKey();
        }

        const instructions = [];
        let invoiceList: commonpb.InvoiceList | undefined;
        if (batch.memo) {
            instructions.push(MemoProgram.memo({data: batch.memo}));
        } else if (this.appIndex) {
            invoiceList = new commonpb.InvoiceList();
            batch.earns.forEach((earn) => {
                if (earn.invoice) {
                    invoiceList!.addInvoices(invoiceToProto(earn.invoice));
                }
            });

            let fk = Buffer.alloc(29);
            if (invoiceList.getInvoicesList().length > 0) {
                if (invoiceList.getInvoicesList().length != batch.earns.length) {
                    return Promise.reject(new Error("either all or none of the earns should have an invoice"));
                }

                const serialized = invoiceList.serializeBinary();
                fk = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex");
            } else {
                invoiceList = undefined;
            }

            const kinMemo = KinMemo.new(1, TransactionType.Earn, this.appIndex!, fk);
            instructions.push(MemoProgram.memo({data: kinMemo.buffer.toString("base64")}));
        }

        batch.earns.forEach((earn) => {
            instructions.push(Token.createTransferInstruction(
                TOKEN_PROGRAM_ID,
                sender.solanaKey(),
                earn.destination.solanaKey(),
                batch.sender.publicKey().solanaKey(),
                [],
                bigNumberToU64(earn.quarks),
            ));
        });

        const tx = new Transaction({
            feePayer: subsidizerId,
        }).add(...instructions);

        return this.signAndSubmitTx(signers, tx, commitment, invoiceList, batch.dedupeId);
    }

    private async signAndSubmitTx(
        signers: PrivateKey[], tx: Transaction, commitment: Commitment, invoiceList?: commonpb.InvoiceList, dedupeId?: Buffer,
    ): Promise<SubmitTransactionResult> {
        let result: SubmitTransactionResult;
        const fn = async () => {
            const blockhash = await this.internal.getRecentBlockhash();
            tx.recentBlockhash = blockhash;
            tx.partialSign(...signers.map((signer) => { return new SolanaAccount(signer.secretKey());}));

            // If the transaction isn't signed by the subsidizer, request a signature.
            let remoteSigned = false;
            if (!tx.signatures[0].signature || tx.signatures[0].signature!.equals(Buffer.alloc(64).fill(0))) {
                const signResult = await this.internal.signTransaction(tx, invoiceList);
                if (signResult.InvoiceErrors) {
                    result = new SubmitTransactionResult();
                    result.InvoiceErrors = signResult.InvoiceErrors;
                    return Promise.resolve(result);
                }

                if (!signResult.TxId) {
                    return Promise.reject(new PayerRequired());
                }

                remoteSigned = true;
                tx.signatures[0].signature = signResult.TxId!;
            }

            result = await this.internal.submitTransaction(tx, invoiceList, commitment, dedupeId);
            if (result.Errors && result.Errors.TxError instanceof BadNonce) {
                if (remoteSigned) {
                    tx.signatures[0].signature = Buffer.alloc(64).fill(0);
                }

                return Promise.reject(new BadNonce());
            }

            return result;
        };

        return retryAsync(fn, limit(this.retryConfig.maxNonceRefreshes), retriableErrors(BadNonce)).catch(err => {
            if (err instanceof BadNonce) {
                return Promise.resolve(result);
            }
            return Promise.reject(err);
        });
    }
}
