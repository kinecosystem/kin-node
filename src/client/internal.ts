import accountgrpcv4 from "@kinecosystem/agora-api/node/account/v4/account_service_grpc_pb";
import accountpbv4 from "@kinecosystem/agora-api/node/account/v4/account_service_pb";
import airdropgrpcv4 from "@kinecosystem/agora-api/node/airdrop/v4/airdrop_service_grpc_pb";
import airdroppbv4 from "@kinecosystem/agora-api/node/airdrop/v4/airdrop_service_pb";
import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import commonpbv4 from "@kinecosystem/agora-api/node/common/v4/model_pb";
import transactiongrpcv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_grpc_pb";
import transactionpbv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_pb";
import { ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
    Account as SolanaAccount,
    PublicKey as SolanaPublicKey,

    Transaction as SolanaTransaction, Transaction
} from "@solana/web3.js";
import BigNumber from "bignumber.js";
import bs58 from "bs58";
import grpc from "@grpc/grpc-js";
import LRUCache from "lru-cache";
import {
    Commitment, commitmentToProto, Memo, PrivateKey,
    PublicKey,
    TransactionData,
    TransactionErrors,
    transactionStateFromProto,
    TransactionType,
    txDataFromProto
} from "../";
import { AccountDoesNotExist, AccountExists, AlreadySubmitted, BadNonce, errorsFromSolanaTx, InsufficientBalance, nonRetriableErrors as nonRetriableErrorsList, NoSubsidizerError, PayerRequired, TransactionRejected } from "../errors";
import { limit, nonRetriableErrors, retryAsync, ShouldRetry } from "../retry";
import { MemoProgram } from "../solana/memo-program";
import { AccountSize } from "../solana/token-program";


export const SDK_VERSION = "0.2.3";
export const USER_AGENT_HEADER = "kin-user-agent";
export const KIN_VERSION_HEADER = "kin-version";
export const APP_INDEX_HEADER = "app-index";
export const DESIRED_KIN_VERSION_HEADER = "desired-kin-version";
export const USER_AGENT = `KinSDK/${SDK_VERSION} node/${process.version}`;
const SERVICE_CONFIG_CACHE_KEY = "GetServiceConfig";
const SIGNATURE_LENGTH = 64;  // Ref: https://github.com/solana-labs/solana-web3.js/blob/5fbdb96bdd9174f0874c450db64acddaa2b004c1/src/transaction.ts#L35

export class SignTransactionResult {
    TxId?: Buffer;
    InvoiceErrors?: commonpb.InvoiceError[];
}

export class SubmitTransactionResult {
    TxId: Buffer;
    InvoiceErrors?: commonpb.InvoiceError[];
    Errors?: TransactionErrors;

    constructor() {
        this.TxId = Buffer.alloc(32);
    }
}

export interface InternalClientConfig {
    endpoint?: string
    accountClientV4?: accountgrpcv4.AccountClient
    airdropClientV4?: airdropgrpcv4.AirdropClient
    txClientV4?: transactiongrpcv4.TransactionClient

    strategies?: ShouldRetry[]
    appIndex?: number
}

// Internal is the low level gRPC client for Agora used by Client.
//
// The interface is _not_ stable, and should not be used. However,
// it is exported in case there is some strong reason that access
// to the underlying blockchain primitives are required.
export class Internal {
    accountClientV4: accountgrpcv4.AccountClient;
    airdropClientV4: airdropgrpcv4.AirdropClient;
    txClientV4: transactiongrpcv4.TransactionClient;
    strategies: ShouldRetry[];
    metadata: grpc.Metadata;
    appIndex: number;
    private responseCache: LRUCache<string, string>;

    constructor(config: InternalClientConfig) {
        if (config.endpoint) {
            if (config.accountClientV4 || config.airdropClientV4 || config.txClientV4) {
                throw new Error("cannot specify endpoint and clients");
            }

            const sslCreds = grpc.credentials.createSsl();
            this.accountClientV4 = new accountgrpcv4.AccountClient(config.endpoint, sslCreds);
            this.airdropClientV4 = new airdropgrpcv4.AirdropClient(config.endpoint, sslCreds);
            this.txClientV4 = new transactiongrpcv4.TransactionClient(config.endpoint, sslCreds);
        } else if (config.accountClientV4) {
            if (!config.accountClientV4 || !config.airdropClientV4 || !config.txClientV4) {
                throw new Error("must specify all gRPC clients");
            }

            this.accountClientV4 = config.accountClientV4;
            this.airdropClientV4 = config.airdropClientV4;
            this.txClientV4 = config.txClientV4;
        } else {
            throw new Error("must specify endpoint or gRPC clients");
        }

        if (config.strategies) {
            this.strategies = config.strategies;
        } else {
            this.strategies = [
                limit(3),
                nonRetriableErrors(...nonRetriableErrorsList),
            ];
        }

        this.metadata = new grpc.Metadata();
        this.metadata.set(USER_AGENT_HEADER, USER_AGENT);
        this.metadata.set(KIN_VERSION_HEADER, "4");

        this.appIndex = config.appIndex ? config.appIndex! : 0;
        if (this.appIndex > 0) {
            this.metadata.set(APP_INDEX_HEADER, this.appIndex.toString());
        }

        // Currently only caching GetServiceConfig, so limit to 1 entry
        this.responseCache = new LRUCache({
            max: 1,
            maxAge: 24 * 60 * 60 * 1000, // 24 hours
        });
    }

    async getBlockchainVersion(): Promise<number> {
        const req = new transactionpbv4.GetMinimumKinVersionRequest();
        return retryAsync(() => {
            return new Promise<number>((resolve, reject) => {
                this.txClientV4.getMinimumKinVersion(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    resolve(resp.getVersion());
                });
            });
        }, ...this.strategies);
    }

    async createAccount(key: PrivateKey, commitment: Commitment = Commitment.Single, subsidizer?: PrivateKey): Promise<void> {
        const fn = async() => {
            const [serviceConfigResp, recentBlockhash] = await Promise.all([
                this.getServiceConfig(),
                this.getRecentBlockhash(),
            ]);
            if (!subsidizer && !serviceConfigResp.getSubsidizerAccount()) {
                throw new NoSubsidizerError();
            }

            let subsidizerKey: SolanaPublicKey;
            if (subsidizer) {
                subsidizerKey = subsidizer!.publicKey().solanaKey();
            } else {
                subsidizerKey = new SolanaPublicKey(Buffer.from(serviceConfigResp.getSubsidizerAccount()!.getValue_asU8()));
            }
            const mint = new SolanaPublicKey(Buffer.from(serviceConfigResp.getToken()!.getValue_asU8()));

            const instructions = [];
            if (this.appIndex > 0) {
                const kinMemo = Memo.new(1, TransactionType.None, this.appIndex!, Buffer.alloc(29));
                instructions.push(MemoProgram.memo({data: kinMemo.buffer.toString("base64")}));
            }

            const assocAddr = await Token.getAssociatedTokenAddress(
                ASSOCIATED_TOKEN_PROGRAM_ID,
                TOKEN_PROGRAM_ID,
                mint,
                key.publicKey().solanaKey(),
            );
            instructions.push(Token.createAssociatedTokenAccountInstruction(
                ASSOCIATED_TOKEN_PROGRAM_ID,
                TOKEN_PROGRAM_ID,
                mint,
                assocAddr,
                key.publicKey().solanaKey(),
                subsidizerKey,
            ));

            instructions.push(Token.createSetAuthorityInstruction(
                TOKEN_PROGRAM_ID,
                assocAddr,
                subsidizerKey,
                "CloseAccount",
                key.publicKey().solanaKey(),
                []
            ));

            const transaction = new Transaction({
                feePayer: subsidizerKey,
                recentBlockhash: recentBlockhash,
            }).add(...instructions);

            transaction.partialSign(new SolanaAccount(key.secretKey()));
            if (subsidizer) {
                transaction.partialSign(new SolanaAccount(subsidizer.secretKey()));
            }

            const protoTx = new commonpbv4.Transaction();
            protoTx.setValue(transaction.serialize({
                requireAllSignatures: false,
                verifySignatures: false,
            }));

            const req = new accountpbv4.CreateAccountRequest();
            req.setTransaction(protoTx);
            req.setCommitment(commitmentToProto(commitment));

            return new Promise<void>((resolve, reject) => {
                this.accountClientV4.createAccount(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    switch (resp.getResult()) {
                        case accountpbv4.CreateAccountResponse.Result.EXISTS:
                            reject(new AccountExists());
                            break;
                        case accountpbv4.CreateAccountResponse.Result.PAYER_REQUIRED:
                            reject(new PayerRequired());
                            break;
                        case accountpbv4.CreateAccountResponse.Result.BAD_NONCE:
                            reject(new BadNonce());
                            break;
                        case accountpbv4.CreateAccountResponse.Result.OK:
                            resolve();
                            break;
                        default:
                            reject(Error("unexpected result from Agora: " + resp.getResult()));
                            break;
                    }
                });
            });
        };

        return retryAsync(fn, ...this.strategies).catch(err => {
            return Promise.reject(err);
        });
    }

    async getAccountInfo(account: PublicKey, commitment: Commitment = Commitment.Single): Promise<accountpbv4.AccountInfo> {
        const accountId = new commonpbv4.SolanaAccountId();
        accountId.setValue(account.buffer);

        const req = new accountpbv4.GetAccountInfoRequest();
        req.setAccountId(accountId);
        req.setCommitment(commitmentToProto(commitment));

        return retryAsync(() => {
            return new Promise<accountpbv4.AccountInfo>((resolve, reject) => {
                this.accountClientV4.getAccountInfo(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (resp.getResult() === accountpbv4.GetAccountInfoResponse.Result.NOT_FOUND) {
                        reject(new AccountDoesNotExist());
                        return;
                    }

                    resolve(resp.getAccountInfo()!);
                });
            });
        }, ...this.strategies);
    }

    async resolveTokenAccounts(publicKey: PublicKey, includeAccountInfo = false): Promise<accountpbv4.AccountInfo[]> {
        const accountId = new commonpbv4.SolanaAccountId();
        accountId.setValue(publicKey.buffer);

        const req = new accountpbv4.ResolveTokenAccountsRequest();
        req.setAccountId(accountId);
        req.setIncludeAccountInfo(includeAccountInfo);

        return retryAsync(() => {
            return new Promise<accountpbv4.ResolveTokenAccountsResponse>((resolve, reject) => {
                this.accountClientV4.resolveTokenAccounts(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    resolve(resp);
                });
            });
        }, ...this.strategies).then(resp => {
            const tokenAccounts = resp.getTokenAccountsList();
            const tokenAccountInfos = resp.getTokenAccountInfosList();

            // This is currently in place for backward compat with the server - `tokenAccounts` is deprecated
            if (tokenAccounts.length > 0 && tokenAccountInfos.length != tokenAccounts.length) {
                // If we aren't requesting account info, we can interpolate the results ourselves
                if (!includeAccountInfo) {
                    resp.setTokenAccountInfosList(tokenAccounts.map(tokenAccount => {
                        const accountInfo = new accountpbv4.AccountInfo();
                        accountInfo.setAccountId(tokenAccount);
                        return accountInfo;
                    }));
                } else {
                    throw new Error("server does not support resolving with account info");
                }
            }

            return Promise.resolve(resp.getTokenAccountInfosList());
        });
    }

    async signTransaction(tx: SolanaTransaction, invoiceList?: commonpb.InvoiceList): Promise<SignTransactionResult> {
        const protoTx = new commonpbv4.Transaction();
        protoTx.setValue(tx.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
        }));

        const req = new transactionpbv4.SignTransactionRequest();
        req.setTransaction(protoTx);
        req.setInvoiceList(invoiceList);

        return retryAsync(() => {
            return new Promise<SignTransactionResult>((resolve, reject) => {
                this.txClientV4.signTransaction(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const result = new SignTransactionResult();

                    if (resp.getSignature()?.getValue_asU8().length === SIGNATURE_LENGTH) {
                        result.TxId = Buffer.from(resp.getSignature()!.getValue_asU8());
                    }

                    switch (resp.getResult()) {
                        case transactionpbv4.SignTransactionResponse.Result.OK:
                            break;
                        case transactionpbv4.SignTransactionResponse.Result.REJECTED:
                            reject(new TransactionRejected());
                            break;
                        case transactionpbv4.SignTransactionResponse.Result.INVOICE_ERROR:
                            result.InvoiceErrors = resp.getInvoiceErrorsList();
                            break;
                        default:
                            reject("unexpected result from agora: " + resp.getResult());
                            return;
                    }

                    resolve(result);
                });
            });
        }, ...this.strategies);
    }

    async submitTransaction(tx: SolanaTransaction, invoiceList?: commonpb.InvoiceList, commitment: Commitment = Commitment.Single, dedupeId?: Buffer): Promise<SubmitTransactionResult> {
        const protoTx = new commonpbv4.Transaction();
        protoTx.setValue(tx.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
        }));

        const req = new transactionpbv4.SubmitTransactionRequest();
        req.setTransaction(protoTx);
        req.setInvoiceList(invoiceList);
        req.setCommitment(commitmentToProto(commitment));
        if (dedupeId) {
            req.setDedupeId(dedupeId!);
        }

        let attempt = 0;
        return retryAsync(() => {
            return new Promise<SubmitTransactionResult>((resolve, reject) => {
                attempt = attempt + 1;
                this.txClientV4.submitTransaction(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const result = new SubmitTransactionResult();
                    if (resp.getSignature()?.getValue_asU8().length === SIGNATURE_LENGTH) {
                        result.TxId = Buffer.from(resp.getSignature()!.getValue_asU8());
                    }

                    switch (resp.getResult()) {
                        case transactionpbv4.SubmitTransactionResponse.Result.OK: {
                            break;
                        }
                        case transactionpbv4.SubmitTransactionResponse.Result.ALREADY_SUBMITTED: {
                            // If this occurs on the first attempt, it's likely due to the submission of two identical transactions
                            // in quick succession and we should raise the error to the caller. Otherwise, it's likely that the
                            // transaction completed successfully on a previous attempt that failed due to a transient error.
                            if (attempt == 1) {
                                reject(new AlreadySubmitted("", result.TxId));
                                return;
                            }
                            break;
                        }
                        case transactionpbv4.SubmitTransactionResponse.Result.REJECTED: {
                            reject(new TransactionRejected());
                            return;
                        }
                        case transactionpbv4.SubmitTransactionResponse.Result.PAYER_REQUIRED: {
                            reject(new PayerRequired());
                            return;
                        }
                        case transactionpbv4.SubmitTransactionResponse.Result.INVOICE_ERROR: {
                            result.InvoiceErrors = resp.getInvoiceErrorsList();
                            break;
                        }
                        case transactionpbv4.SubmitTransactionResponse.Result.FAILED: {
                            result.Errors = errorsFromSolanaTx(tx, resp.getTransactionError()!, result.TxId);
                            break;
                        }
                        default:
                            reject("unexpected result from agora: " + resp.getResult());
                            return;
                    }

                    resolve(result);
                });
            });
        }, ...this.strategies);
    }

    async getTransaction(id: Buffer, commitment: Commitment = Commitment.Single): Promise<TransactionData | undefined> {
        const transactionId = new commonpbv4.TransactionId();
        transactionId.setValue(id);

        const req = new transactionpbv4.GetTransactionRequest();
        req.setTransactionId(transactionId);
        req.setCommitment(commitmentToProto(commitment));

        return retryAsync(() => {
            return new Promise<TransactionData | undefined>((resolve, reject) => {
                this.txClientV4.getTransaction(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    let data: TransactionData;
                    if (resp.getItem()) {
                        data = txDataFromProto(resp.getItem()!, resp.getState());
                    } else {
                        data = new TransactionData();
                        data.txId = id;
                        data.txState = transactionStateFromProto(resp.getState());
                    }

                    resolve(data);
                });
            });
        }, ...this.strategies);
    }

    async getServiceConfig(): Promise<transactionpbv4.GetServiceConfigResponse> {
        const req = new transactionpbv4.GetServiceConfigRequest();
        return retryAsync(() => {
            return new Promise<transactionpbv4.GetServiceConfigResponse>((resolve, reject) => {
                const cached = this.responseCache.get(SERVICE_CONFIG_CACHE_KEY);
                if (cached) {
                    const resp = transactionpbv4.GetServiceConfigResponse.deserializeBinary(Buffer.from(cached, "base64"));
                    resolve(resp);
                    return;
                }

                this.txClientV4.getServiceConfig(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    this.responseCache.set(SERVICE_CONFIG_CACHE_KEY, Buffer.from(resp.serializeBinary()).toString("base64"));
                    resolve(resp);
                });
            });
        }, ...this.strategies);
    }

    async getRecentBlockhash(): Promise<string> {
        const req = new transactionpbv4.GetRecentBlockhashRequest();
        return retryAsync(() => {
            return new Promise<string>((resolve, reject) => {
                this.txClientV4.getRecentBlockhash(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    resolve(bs58.encode(Buffer.from(resp.getBlockhash()!.getValue_asU8())));
                });
            });
        }, ...this.strategies);
    }

    async getMinimumBalanceForRentExemption(): Promise<number> {
        const req = new transactionpbv4.GetMinimumBalanceForRentExemptionRequest();
        req.setSize(AccountSize);

        return retryAsync(() => {
            return new Promise<number>((resolve, reject) => {
                this.txClientV4.getMinimumBalanceForRentExemption(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    resolve(resp.getLamports());
                });
            });
        }, ...this.strategies);
    }

    async requestAirdrop(publicKey: PublicKey, quarks: BigNumber, commitment: Commitment = Commitment.Single): Promise<Buffer> {
        const accountId = new commonpbv4.SolanaAccountId();
        accountId.setValue(publicKey.buffer);

        const req = new airdroppbv4.RequestAirdropRequest();
        req.setAccountId(accountId);
        req.setQuarks(quarks.toNumber());
        req.setCommitment(commitmentToProto(commitment));

        return retryAsync(() => {
            return new Promise<Buffer>((resolve, reject) => {
                this.airdropClientV4.requestAirdrop(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    switch (resp.getResult()) {
                        case (airdroppbv4.RequestAirdropResponse.Result.OK):
                            resolve(Buffer.from(resp.getSignature()!.getValue_asU8()));
                            return;
                        case (airdroppbv4.RequestAirdropResponse.Result.NOT_FOUND):
                            reject(new AccountDoesNotExist());
                            return;
                        case (airdroppbv4.RequestAirdropResponse.Result.INSUFFICIENT_KIN):
                            reject(new InsufficientBalance());
                            return;
                        default:
                            reject("unexpected result from agora: " + resp.getResult());
                            return;
                    }
                });
            });
        }, ...this.strategies);
    }
}
