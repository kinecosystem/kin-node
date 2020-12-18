import grpc from "grpc";
import hash from "hash.js";
import BigNumber from "bignumber.js";
import {
    TransactionBuilder,
    Memo,
    MemoHash,
    xdr,
    Account,
    Operation,
    Asset
} from "stellar-base";
import LRUCache from 'lru-cache';
import { Account as SolanaAccount, PublicKey as SolanaPublicKey, Transaction as SolanaTransaction, Transaction } from "@solana/web3.js";

import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import accountgrpc from "@kinecosystem/agora-api/node/account/v3/account_service_grpc_pb";
import transactiongrpc from "@kinecosystem/agora-api/node/transaction/v3/transaction_service_grpc_pb";
import accountgrpcv4 from "@kinecosystem/agora-api/node/account/v4/account_service_grpc_pb";
import airdropgrpcv4 from "@kinecosystem/agora-api/node/airdrop/v4/airdrop_service_grpc_pb";
import transactiongrpcv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_grpc_pb";
import transactionpbv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_pb";

import {
    AccountResolution,
    Commitment,
    Earn,
    EarnBatch,
    EarnBatchResult,
    Environment,
    invoiceToProto, Kin2Issuers, KinAssetCode,
    Memo as KinMemo,
    NetworkPasshrase,
    Payment,
    PrivateKey,
    PublicKey,
    TransactionData,
    TransactionType,
} from "../";
import { InternalClient, SubmitTransactionResult } from "./";
import { AlreadyPaid, SkuNotFound, WrongDestination, BadNonce, AccountDoesNotExist, NoSubsidizerError, nonRetriableErrors as nonRetriableErrorList, NoTokenAccounts } from "../errors";
import { retryAsync, limit, retriableErrors, backoffWithJitter, binaryExpotentialDelay, nonRetriableErrors } from "../retry";
import { InternalClientConfig } from "./internal";
import { MemoProgram } from "../solana/memo-program";
import { TokenProgram } from "../solana/token-program";

export interface ClientConfig {
    endpoint?:        string
    internal?:        InternalClient
    accountClient?:   accountgrpc.AccountClient
    txClient?:        transactiongrpc.TransactionClient
    accountClientV4?: accountgrpcv4.AccountClient
    airdropClientV4?: airdropgrpcv4.AirdropClient
    txClientV4?:      transactiongrpcv4.TransactionClient

    appIndex?: number
    retryConfig?: RetryConfig

    // An optional whitelist key to sign every transaction with.
    whitelistKey?: PrivateKey

    kinVersion?: number
    
    // A debugging parameter to force Agora to use a minimum kin version.
    desiredKinVersion?: number

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

// Maximum size taken from: https://github.com/solana-labs/solana/blob/39b3ac6a8d29e14faa1de73d8b46d390ad41797b/sdk/src/packet.rs#L9-L13
const maxTxSize = 1232;

// Client is the primary class that should be used for interacting with kin.
//
// Client abstracts away the underlying blockchain implementations, allowing for
// easier upgrades in the future.
export class Client {
    internal:           InternalClient;
    networkPassphrase?: string;
    retryConfig: RetryConfig;

    appIndex?:          number;
    whitelistKey?:      PrivateKey;
    kinVersion:         number;
    issuer?:            string;
    defaultCommitment:  Commitment;
    accountCache:       LRUCache<string, string>;


    constructor(env: Environment, conf?: ClientConfig) {
        if (conf?.endpoint) {
            if (conf?.internal) {
                throw new Error("cannot specify both endpoint and internal client");
            }
            if (conf?.accountClient || conf?.txClient || conf?.accountClientV4 || conf?.airdropClientV4 || conf?.txClientV4) {
                throw new Error("cannot specify both endpoint and gRPC clients");
            }
        } else if (conf?.internal) {
            if (conf?.accountClient || conf?.txClient || conf?.accountClientV4 || conf?.airdropClientV4 || conf?.txClientV4) {
                throw new Error("cannot specify both internal and gRPC clients");
            }
        } else if (
            (conf?.accountClient == undefined) !== (conf?.txClient == undefined) ||
            (conf?.accountClient == undefined) !== (conf?.accountClientV4 == undefined) ||
            (conf?.accountClient == undefined) !== (conf?.airdropClientV4 == undefined) ||
            (conf?.accountClient == undefined) !== (conf?.txClientV4 == undefined)
        ) {
            throw new Error("either all or none of the gRPC clients must be set");
        }

        if (conf?.kinVersion) {
            this.kinVersion = conf.kinVersion;
        } else {
            this.kinVersion = 3;
        }
        let defaultEndpoint: string;
        switch (env) {
            case Environment.Test:
                this.networkPassphrase = NetworkPasshrase.Test;
                defaultEndpoint = "api.agorainfra.dev:443";
                if (this.kinVersion === 2) {
                    this.networkPassphrase = NetworkPasshrase.Kin2Test;
                    this.issuer = Kin2Issuers.Test;
                } else if (this.kinVersion == 3)  {
                    this.networkPassphrase = NetworkPasshrase.Test;
                }
                break;
            case Environment.Prod:
                defaultEndpoint = "api.agorainfra.net:443";
                if (this.kinVersion === 2) {
                    this.networkPassphrase = NetworkPasshrase.Kin2Prod;
                    this.issuer = Kin2Issuers.Prod;
                } else if (this.kinVersion == 3)  {
                    this.networkPassphrase = NetworkPasshrase.Prod;
                }
                break;
            default:
                throw new Error("unsupported env:" + env);
        }

        if (conf) {
            this.appIndex = conf.appIndex;
            this.whitelistKey = conf.whitelistKey;
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

        if (conf?.defaultCommitment) {
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
            accountClient: conf?.accountClient,
            txClient: conf?.txClient,
            kinVersion: this.kinVersion,
            desiredKinVersion: conf?.desiredKinVersion,
        };
        if (!internalConf.endpoint && !internalConf.accountClient && !internalConf.endpoint) {
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
        switch (this.kinVersion) {
            case 2:
            case 3:
                return this.internal.createStellarAccount(key)
                    .catch(err => {
                        if (err.code && err.code === grpc.status.FAILED_PRECONDITION) {
                            this.kinVersion = 4;
                            this.internal.setKinVersion(4);

                            return retryAsync(async() => {
                                return this.internal.createSolanaAccount(key, commitment, subsidizer);
                            }, limit(this.retryConfig.maxNonceRefreshes), retriableErrors(BadNonce));
                        }

                        return Promise.reject(err);
                    });
            case 4:
                return retryAsync(async() => {
                    return this.internal.createSolanaAccount(key, commitment, subsidizer);
                }, limit(this.retryConfig.maxNonceRefreshes), retriableErrors(BadNonce));
            default:
                return Promise.reject("unsupported kin version: " + this.kinVersion);
        }
    }

    // getBalance retrieves the balance for an account.
    //
    // Promise.reject(new AccountDoesNotExist()) is called if
    // the specified account does not exist.
    async getBalance(account: PublicKey, commitment: Commitment = this.defaultCommitment, accountResolution: AccountResolution = AccountResolution.Preferred): Promise<BigNumber> {
        if (this.kinVersion > 4 || this.kinVersion < 2) {
            return Promise.reject("unsupported kin version: " + this.kinVersion);
        }

        const solanaFn = async (): Promise<BigNumber> => {
            return this.internal.getSolanaAccountInfo(account, commitment)
                .then(info => new BigNumber(info.getBalance()))
                .catch(err => {
                    if (err instanceof AccountDoesNotExist) {
                        if (accountResolution == AccountResolution.Preferred) {
                            return this.getTokenAccounts(account)
                                .then(accounts => {
                                    if (accounts.length > 0) {
                                        return this.internal.getSolanaAccountInfo(accounts[0], commitment)
                                            .then(info => new BigNumber(info.getBalance()));
                                    }
                                    return Promise.reject(err);
                                });
                        }
                    }
                    return Promise.reject(err);
                });
        };

        if (this.kinVersion < 4) {
            return this.internal.getAccountInfo(account)
                .then(info => new BigNumber(info.getBalance()))
                .catch(err => {
                    if (err.code && err.code === grpc.status.FAILED_PRECONDITION) {
                        this.kinVersion = 4;
                        this.internal.setKinVersion(4);
                        return solanaFn();
                    }
                    return Promise.reject(err);
                });
        }

        return solanaFn();
    }

    // getTransaction retrieves the TransactionData for a txId.
    //
    // If no transaction data currently exists, Promise.resolve(undefined)
    // is called. In this state, the transaction may or may not resolve in
    // the future, it is simply unknown _at this time_.
    async getTransaction(txId: Buffer, commitment: Commitment = this.defaultCommitment): Promise<TransactionData|undefined> {
        switch (this.kinVersion) {
            case 2:
            case 3:
                return this.internal.getStellarTransaction(txId);
            case 4:
                return this.internal.getTransaction(txId, commitment);
            default:
                return Promise.reject("unsupported kin version: " + this.kinVersion);
        }
    }

    // submitPayment submits a payment.
    //
    // If the payment has an invoice, an app index _must_ be set.
    // If the payment has a memo, an invoice cannot also be provided.
    async submitPayment(
        payment: Payment, commitment: Commitment = this.defaultCommitment, senderResolution: AccountResolution = AccountResolution.Preferred, 
        destinationResolution: AccountResolution = AccountResolution.Preferred
    ): Promise<Buffer> {
        if (this.kinVersion > 4 || this.kinVersion < 2) {
            return Promise.reject("unsupported kin version: " + this.kinVersion);
        }

        if (payment.invoice && !this.appIndex) {
            return Promise.reject("cannot submit payment with invoices without an app index");
        }

        let result: SubmitTransactionResult;
        if (this.kinVersion === 4) {
            result = await this.submitPaymentWithResolution(payment, commitment, senderResolution, destinationResolution);
        } else {
            let signers: PrivateKey[];
            if (payment.channel && !payment.channel!.equals(payment.sender)) {
                signers = [payment.channel, payment.sender];
            } else {
                signers = [payment.sender];
            }

            let memo: Memo | undefined;
            let invoiceList: commonpb.InvoiceList | undefined;
            if (payment.memo) {
                memo = Memo.text(payment.memo);
            } else if (this.appIndex) {
                let fk = Buffer.alloc(29);

                if (payment.invoice) {
                    invoiceList = new commonpb.InvoiceList();
                    invoiceList.addInvoices(invoiceToProto(payment.invoice));

                    const serialized = invoiceList.serializeBinary();
                    fk = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex");
                }

                const kinMemo = KinMemo.new(1, payment.type, this.appIndex!, fk);
                memo = new Memo(MemoHash, kinMemo.buffer);
            }

            let asset: Asset;
            let quarksConversion: number;
            if (this.kinVersion === 2) {
                asset = new Asset(KinAssetCode, this.issuer);
                quarksConversion = 1e5;
            } else {
                asset = Asset.native();
                // In Kin, the base currency has been 'scaled' by
                // a factor of 100 from stellar. That is, 1 Kin is 100x
                // 1 XLM, and the minimum amount is 1e-5 instead of 1e-7.
                //
                // Since js-stellar's amount here is an XLM (equivalent to Kin),
                // we need to convert it to a quark (divide by 1e5), and then also
                // account for the 100x scaling factor. 1e5 / 100 = 1e7.
                quarksConversion = 1e7;
            }

            const op = Operation.payment({
                source: payment.sender.publicKey().stellarAddress(),
                destination: payment.destination.stellarAddress(),
                asset: asset,
                amount: payment.quarks.dividedBy(quarksConversion).toFixed(7),
            });

            // TODO: handle version
            result = await this.signAndSubmit(signers, [op], memo, invoiceList)
                .catch(err => {
                    if (err.code && err.code === grpc.status.FAILED_PRECONDITION) {
                        this.kinVersion = 4;
                        this.internal.setKinVersion(4);
                        return this.submitPaymentWithResolution(payment, commitment, senderResolution, destinationResolution);
                    }
                    return Promise.reject(err);
                });            
        }

        if (result.Errors && result.Errors.OpErrors) {
            if (result.Errors.OpErrors.length != 1) {
                return Promise.reject(new Error("invalid number of operation errors. expected 0 or 1"));
            }

            return Promise.reject(result.Errors.OpErrors[0]);
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

    // submitEarnBatch submits an EarnBatch.
    //
    // Depending on the size of the EarnBatch, the client may break up
    // the batch into multiple sub-batches. As a result, it is possible
    // for partial failures to occur.
    //
    // If partial failures cannot be tolerated, then submitPayment with type Earn,
    // or submitBatch with a batch size of 1 should be used.
    async submitEarnBatch(
        batch: EarnBatch, commitment: Commitment = this.defaultCommitment, senderResolution: AccountResolution = AccountResolution.Preferred, 
        destinationResolution: AccountResolution = AccountResolution.Preferred
    ): Promise<EarnBatchResult> {
        if (this.kinVersion !== 4 && this.kinVersion !== 3 && this.kinVersion !== 2) {
            return Promise.reject("unsupported kin version: " + this.kinVersion);
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

        let batches: EarnBatch[];
        let serviceConfig: transactionpbv4.GetServiceConfigResponse | undefined;
        if (this.kinVersion === 2 || this.kinVersion === 3) {
            // Stellar has an operation batch size of 100, so we break apart the EarnBatch into
            // sub-batches of 100 each.
            batches = [];
            for (let start = 0; start < batch.earns.length; start += 100) {
                const end = Math.min(start+100, batch.earns.length);
                batches.push({
                    sender: batch.sender,
                    channel: batch.channel,
                    memo: batch.memo,
                    earns: batch.earns.slice(start, end),
                });
            }
        } else {
            batches = this.partitionSolanaEarns(batch, senderResolution);
            serviceConfig = await this.internal.getServiceConfig();
            if (!serviceConfig.getSubsidizerAccount() && !batch.subsidizer) {
                return Promise.reject(new NoSubsidizerError());
            }
        }

        const batchResult = new EarnBatchResult();

        let unprocessedBatch = 0;
        for (let i = 0; i < batches.length; i++) {
            const b = batches[i];

            let result: SubmitTransactionResult;
            try {
                if (this.kinVersion === 2 || this.kinVersion === 3) {
                    result = await this.submitSingleEarnBatch(b);
                } else {
                    result = await this.submitEarnBatchWithResolution(b, serviceConfig!, commitment, senderResolution, destinationResolution);
                }
            } catch (err) {
                for (let j = 0; j < b.earns.length; j++) {
                    batchResult.failed.push({
                        earn: b.earns[j],
                        error: err,
                    });
                }

                unprocessedBatch = i + 1;
                break;
            }

            if (!result.Errors || !result.Errors.TxError) {
                for (const r of b.earns) {
                    batchResult.succeeded.push({
                        txId: result.TxId,
                        earn: r,
                    });
                }

                unprocessedBatch = i + 1;
                continue;
            }

            // At this point, we consider the batch failed.

            // If there was operation level errors, we set the individual results
            // for this batch, and then mark the rest of the earns as aborted.
            if (result.Errors.OpErrors) {
                for (let j = 0; j < result.Errors.OpErrors.length; j++) {
                    batchResult.failed.push({
                        txId: result.TxId,
                        earn: b.earns[j],
                        error: result.Errors.OpErrors[j],
                    });
                }
            } else {
                for (let j = 0; j < b.earns.length; j++) {
                    batchResult.failed.push({
                        txId: result.TxId,
                        earn: b.earns[j],
                        error: result.Errors.TxError,
                    });
                }
            }

            unprocessedBatch = i + 1;

            break;
        }
        
        for (let i = unprocessedBatch; i < batches.length; i++) {
            for (const r of batches[i].earns) {
                batchResult.failed.push({
                    earn: r,
                });
            }
        }

        return Promise.resolve(batchResult);
    }

    // resolveTokenAccounts resolves the token accounts ovned by the specified account on kin 4.
    async resolveTokenAccounts(account: PublicKey): Promise<PublicKey[]> {
        if (this.kinVersion !== 4) {
            return Promise.reject("`resolve_token_accounts` is only available on Kin 4");
        }

        return this.getTokenAccounts(account);
    }

    private partitionSolanaEarns(batch: EarnBatch, senderResolution: AccountResolution): EarnBatch[] {
        const includeKinMemo = (batch.memo == undefined && this.appIndex != undefined);
        const batches: EarnBatch[] = [];

        let offset = 0;
        for (let i = 0; i < batch.earns.length + 1; i += 1) {
            // To avoid having to re-partition earns in the case that the sender account needs to be resolved, if sender
            // resolution is PREFERRED, include it in the estimation of the transaction size
            const txSize = this.estimateEarnBatchTxSize(
                batch.earns.slice(offset, i), 
                senderResolution === AccountResolution.Preferred,
                includeKinMemo,
                batch.memo);
            if (txSize > maxTxSize) {
                batches.push({
                    sender: batch.sender,
                    channel: batch.channel,
                    subsidizer: batch.subsidizer,
                    memo: batch.memo,
                    earns: batch.earns.slice(offset,i-1),
                });
                offset = i - 1;
            } else if (txSize === maxTxSize || i === batch.earns.length) {
                batches.push({
                    sender: batch.sender,
                    channel: batch.channel,
                    subsidizer: batch.subsidizer,
                    memo: batch.memo,
                    earns: batch.earns.slice(offset, i)
                });
                offset = i;
            }
        }

        return batches;
    }

    // estimateEarnBatchTxSize estimates the size of an earn batch transaction by adding following components:
    // - Signatures: 1 (shortvec) + sig_count * SIGNATURE_LENGTH
    // - Header bytes: 3
    // - Accounts: 1 (shortvec) + account_count * ED25519_PUB_KEY_SIZE
    // - Hash Length
    // - For instructions:
    //     - 1 byte (shortvec)
    //     - (optional, if Agora memo included) Agora memo: ED25519_PUB_KEY_SIZE + 1 (program index) + 1 (account
    //       shortvec) + 1 (data shortvec) + 44 (length of a base64-encoded Agora memo) = 79
    //     - (optional) memo: ED25519_PUB_KEY_SIZE + 1 (program index) + 1 (account shortvec) + data shortvec +
    //       len(data) = 34 + data shortvec + len(data)
    //     - Each transfer: 1 (program index) + 1 (account shortvec) + 3 (3 account indices) + 1 (data shortvec) +
    //       9 (transfer data length) = 15
    private estimateEarnBatchTxSize(earns: Earn[], hasSeparateSender: boolean, hasAgoraMemo: boolean, memo?: string): number {
        const uniqueDests = new Set();
        earns.forEach(earn => {
            uniqueDests.add(earn.destination.toBase58());
        });
        // unique destinations + subsidizer + owner + program + (optional) resolved transfer sender
        const accountCount = uniqueDests.size + 3 + (hasSeparateSender ? 1 : 0);
        // owner, subsidizer
        const sigCount = 2;

        return (
            1 + (sigCount * 64) + 
            3 +
            this.estimateShortVecSize(accountCount) + (accountCount * 32) +
            32 +
            1 +
            (hasAgoraMemo ? 79 : 0) +
            (memo ? (34 + this.estimateShortVecSize(memo.length) + memo.length) : 0) + 
            (earns.length * 15)
        );
    }

    private estimateShortVecSize(length: number): number {
        return (length < 128 ? 1 : (length < 16384 ? 2 : 3));
    }

    private async submitPaymentWithResolution(
        payment: Payment, commitment: Commitment, senderResolution: AccountResolution = AccountResolution.Preferred, 
        destinationResolution: AccountResolution = AccountResolution.Preferred
    ): Promise<SubmitTransactionResult> {
        const serviceConfig = await this.internal.getServiceConfig();
        if (!serviceConfig.getSubsidizerAccount() && !payment.subsidizer) {
            return Promise.reject(new NoSubsidizerError());
        }

        let result = await this.submitSolanaPayment(payment, serviceConfig, commitment);
        if (result.Errors && result.Errors.TxError instanceof AccountDoesNotExist) {
            let transferSender: PublicKey | undefined = undefined;
            let resubmit = false;

            if (senderResolution == AccountResolution.Preferred) {
                const tokenAccounts = await this.getTokenAccounts(payment.sender.publicKey());
                if (tokenAccounts.length > 0) {
                    transferSender = tokenAccounts[0];
                    resubmit = true;
                }
            }

            if (destinationResolution == AccountResolution.Preferred) {
                const tokenAccounts = await this.getTokenAccounts(payment.destination);
                if (tokenAccounts.length > 0) {
                    payment.destination = tokenAccounts[0];
                    resubmit = true;
                }
            }

            if (resubmit) {
                result = await this.submitSolanaPayment(payment, serviceConfig, commitment, transferSender);
            }
        }

        return result;
    }

    private async submitSolanaPayment(
        payment: Payment, serviceConfig: transactionpbv4.GetServiceConfigResponse, commitment: Commitment, transferSender?: PublicKey
    ): Promise<SubmitTransactionResult> {
        const tokenProgram = new PublicKey(Buffer.from(serviceConfig.getTokenProgram()!.getValue_asU8()));

        let subsidizerKey: SolanaPublicKey;
        let signers: PrivateKey[];
        if (payment.subsidizer) {
            subsidizerKey = payment.subsidizer!.publicKey().solanaKey();
            signers = [payment.subsidizer, payment.sender];
        } else {
            subsidizerKey = new SolanaPublicKey(Buffer.from(serviceConfig.getSubsidizerAccount()!.getValue_asU8()));
            signers = [payment.sender];
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
        
        let sender: PublicKey;
        if (transferSender) {
            sender = transferSender;
        } else {
            sender = payment.sender.publicKey();
        }

        instructions.push(TokenProgram.transfer({
            source: sender.solanaKey(),
            dest: payment.destination.solanaKey(),
            owner: payment.sender.publicKey().solanaKey(),
            amount: BigInt(payment.quarks)
        }, tokenProgram.solanaKey()));
        
        const tx = new Transaction({
            feePayer: subsidizerKey,
        }).add(...instructions);

        return this.signAndSubmitSolanaTx(signers, tx, commitment, invoiceList);
    }

    private async submitEarnBatchWithResolution(
        batch: EarnBatch, serviceConfig: transactionpbv4.GetServiceConfigResponse,
        commitment: Commitment, senderResolution: AccountResolution = AccountResolution.Preferred, 
        destinationResolution: AccountResolution = AccountResolution.Preferred
    ): Promise<SubmitTransactionResult> {
        let result = await this.submitSolanaEarnBatch(batch, serviceConfig, commitment);
        if (result.Errors && result.Errors.TxError instanceof AccountDoesNotExist) {
            let transferSender: PublicKey | undefined = undefined;
            let resubmit = false;

            if (senderResolution == AccountResolution.Preferred) {
                const tokenAccounts = await this.getTokenAccounts(batch.sender.publicKey());
                if (tokenAccounts.length > 0) {
                    transferSender = tokenAccounts[0];
                    resubmit = true;
                }
            }

            if (destinationResolution == AccountResolution.Preferred) {
                for (let i = 0; i < batch.earns.length; i += 1) {
                    const tokenAccounts = await this.getTokenAccounts(batch.earns[i].destination);
                    if (tokenAccounts.length > 0) {
                        batch.earns[i].destination = tokenAccounts[0];
                        resubmit = true;
                    }
                }
            }

            if (resubmit) {
                result = await this.submitSolanaEarnBatch(batch, serviceConfig, commitment, transferSender);
            }
        }

        return result;
    }

    private async submitSolanaEarnBatch(
        batch: EarnBatch, serviceConfig: transactionpbv4.GetServiceConfigResponse, commitment: Commitment, transferSender?: PublicKey
    ): Promise<SubmitTransactionResult> {
        const tokenProgram = new SolanaPublicKey(serviceConfig.getTokenProgram()!.getValue_asU8());
        let subsidizerId: SolanaPublicKey;
        let signers: PrivateKey[];
        if (batch.subsidizer) {
            subsidizerId = batch.subsidizer!.publicKey().solanaKey();
            signers = [batch.subsidizer!, batch.sender];
        } else {
            subsidizerId = new SolanaPublicKey(serviceConfig.getSubsidizerAccount()!.getValue_asU8());
            signers = [batch.sender];
        }

        let sender: PublicKey;
        if (transferSender) {
            sender = transferSender;
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
            instructions.push(TokenProgram.transfer({
                source: sender.solanaKey(),
                dest: earn.destination.solanaKey(),
                owner: batch.sender.publicKey().solanaKey(),
                amount: BigInt(earn.quarks),
            }, tokenProgram));
        });

        const tx = new Transaction({
            feePayer: subsidizerId,
        }).add(...instructions);

        return this.signAndSubmitSolanaTx(signers, tx, commitment, invoiceList);
    }

    private async submitSingleEarnBatch(batch: EarnBatch): Promise<SubmitTransactionResult> {
        let signers: PrivateKey[];
        if (batch.channel && !batch.channel!.equals(batch.sender)) {
            signers = [batch.channel, batch.sender];
        } else {
            signers = [batch.sender];
        }

        const ops: xdr.Operation[] = [];

        let asset: Asset;
        let quarksConversion: number;
        if (this.kinVersion === 2) {
            asset = new Asset(KinAssetCode, this.issuer);
            quarksConversion = 1e5;
        } else {
            asset = Asset.native();
            // In Kin, the base currency has been 'scaled' by
            // a factor of 100 from stellar. That is, 1 Kin is 100x
            // 1 XLM, and the minimum amount is 1e-5 instead of 1e-7.
            //
            // Since js-stellar's amount here is an XLM (equivalent to Kin),
            // we need to convert it to a quark (divide by 1e5), and then also
            // account for the 100x scaling factor. 1e5 / 100 = 1e7.
            quarksConversion = 1e7;
        }

        for (const e of batch.earns) {
            ops.push(Operation.payment({
                source: batch.sender.publicKey().stellarAddress(),
                destination: e.destination.stellarAddress(),
                asset: asset,
                amount: e.quarks.dividedBy(quarksConversion).toFixed(7),
            }));
        }

        let memo: Memo | undefined;
        let invoiceList: commonpb.InvoiceList | undefined;
        if (batch.memo) {
            memo = Memo.text(batch.memo);
        } else if (this.appIndex) {
            invoiceList = new commonpb.InvoiceList();
            for (const r of batch.earns) {
                if (r.invoice) {
                    invoiceList.addInvoices(invoiceToProto(r.invoice));
                }
            }

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
            memo = new Memo(MemoHash, kinMemo.buffer);
        }

        const result = await this.signAndSubmit(signers, ops, memo, invoiceList);
        if (result.InvoiceErrors) {
            return Promise.reject(new Error("unexpected invoice errors present"));
        }

        return Promise.resolve(result);
    }

    private async signAndSubmitSolanaTx(
        signers: PrivateKey[], tx: SolanaTransaction, commitment: Commitment, invoiceList?: commonpb.InvoiceList
    ): Promise<SubmitTransactionResult> {
        let result: SubmitTransactionResult;
        const fn = async () => {
            const blockhash = await this.internal.getRecentBlockhash();
            tx.recentBlockhash = blockhash;
            tx.partialSign(...signers.map((signer) => { return new SolanaAccount(signer.secretKey());}));

            result = await this.internal.submitSolanaTransaction(tx, invoiceList, commitment);
            if (result.Errors && result.Errors.TxError instanceof BadNonce) {
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

    private async signAndSubmit(signers: PrivateKey[],  operations: xdr.Operation[], memo?: Memo, invoiceList?: commonpb.InvoiceList):  Promise<SubmitTransactionResult> {
        const accountInfo = await this.internal.getAccountInfo(signers[0].publicKey());
        let offset = new BigNumber(0);

        let result: SubmitTransactionResult;
        const fn = async () => {
            const sequence = new BigNumber(accountInfo.getSequenceNumber()).plus(offset);
            const builder = new TransactionBuilder(
                new Account(signers[0].publicKey().stellarAddress(), sequence.toString()),
                {
                    fee: "100",
                    networkPassphrase: this.networkPassphrase,
                    v1: false,
                }
            );
            builder.setTimeout(3600);
            for (const op of operations) {
                builder.addOperation(op);
            }
            if (memo) {
                builder.addMemo(memo!);
            }

            const tx = builder.build();
            tx.sign(...signers.map(s => s.kp));

            if (this.whitelistKey) {
                let signed = false;
                for (const s of signers) {
                    if (s.equals(this.whitelistKey!)) {
                        signed = true;
                    }
                }
                if (!signed) {
                    tx.sign(this.whitelistKey.kp);
                }
            }

            result = await this.internal.submitStellarTransaction(tx.toEnvelope(), invoiceList);
            if (result.Errors && result.Errors.TxError instanceof BadNonce) {
                offset = offset.plus(1);
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

    private async getTokenAccounts(key: PublicKey): Promise<PublicKey[]> {
        const cached = this.getTokensFromCache(key);
        if (cached.length > 0 ) {
            return Promise.resolve(cached);
        }
        
        const fn = async (): Promise<PublicKey[]> => {
            const tokenAccounts = await this.internal.resolveTokenAccounts(key);
            if (tokenAccounts.length == 0) {
                return Promise.reject(new NoTokenAccounts());
            }
            this.setTokenAccountsInCache(key, tokenAccounts);
            return tokenAccounts;
        };
        
        return retryAsync(fn, 
            limit(this.retryConfig.maxRetries),
            backoffWithJitter(binaryExpotentialDelay(this.retryConfig.minDelaySeconds), this.retryConfig.maxDelaySeconds, 0.1)).catch(err => {
                if (err instanceof NoTokenAccounts) {
                    return Promise.resolve([]);
                }
                return Promise.reject(err);
            });
    }

    private setTokenAccountsInCache(key: PublicKey, tokenAccounts: PublicKey[]) {
        this.accountCache.set(key.toBase58(), tokenAccounts.map((tokenAccount) => { 
            return tokenAccount.toBase58();
        }).join(','));
    }

    private getTokensFromCache(key: PublicKey): PublicKey[] {
        const val = this.accountCache.get(key.toBase58());
        if (val) {
            return val.split(',').map((encodedKey) => {
                return PublicKey.fromBase58(encodedKey);
            });
        } else {
            return [];
        }
    }
}
