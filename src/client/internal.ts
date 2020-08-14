import grpc from "grpc";
import commonpb from "agora-api/node/common/v3/model_pb";
import accountpb from "agora-api/node/account/v3/account_service_pb";
import accountgrpc from "agora-api/node/account/v3/account_service_grpc_pb";
import transactionpb from "agora-api/node/transaction/v3/transaction_service_pb";
import transactiongrpc from "agora-api/node/transaction/v3/transaction_service_grpc_pb";

import { xdr } from "stellar-base";

import {
    PrivateKey,
    PublicKey,
    Memo,
    TransactionType,
    TransactionData,
    TransactionErrors,
    paymentsFromEnvelope,
} from "../"
import {errorsFromXdr, AccountDoesNotExist, AccountExists, TransactionRejected} from "../errors"
import {ShouldRetry, retryAsync, limit} from "../retry";

export class SubmitStellarTransactionResult {
    TxHash:         Buffer
    InvoiceErrors?: transactionpb.SubmitTransactionResponse.InvoiceError[]
    Errors?:        TransactionErrors

    constructor() {
        this.TxHash = Buffer.alloc(32);
    }
}

export interface InternalClientConfig {
    endpoint?:      string
    accountClient?: accountgrpc.AccountClient
    txClient?:      transactiongrpc.TransactionClient

    strategies?: ShouldRetry[]
}

// Internal is the low level gRPC client for Agora used by Client.
//
// The interface is _not_ stable, and should not be used. However,
// it is exported in case there is some strong reason that access
// to the underlying blockchain primitives are required.
export class Internal {
    txClient: transactiongrpc.TransactionClient
    accountClient: accountgrpc.AccountClient
    strategies: ShouldRetry[]

    constructor(config: InternalClientConfig) {
        if (config.endpoint) {
            if (config.accountClient || config.txClient) {
                throw new Error("cannot specify endpoint and clients");
            }

            const sslCreds = grpc.credentials.createSsl();
            this.accountClient = new accountgrpc.AccountClient(config.endpoint, sslCreds);
            this.txClient = new transactiongrpc.TransactionClient(config.endpoint, sslCreds);
        } else if (config.accountClient) {
            if (!config.accountClient) {
                throw new Error("must specify both gRPC clients");
            }

            this.accountClient = config.accountClient!;
            this.txClient = config.txClient!;
        } else {
            throw new Error("must specify endpoint or gRPC clients");
        }

        if (config.strategies) {
            this.strategies = config.strategies;
        } else {
            this.strategies = [limit(3)];
        }
    }

    async getBlockchainVersion(): Promise<number> { return Promise.resolve(3); }

    async createStellarAccount(key: PrivateKey): Promise<void> {
        const accountId = new commonpb.StellarAccountId();
        accountId.setValue(key.publicKey().stellarAddress());

        const req = new accountpb.CreateAccountRequest();
        req.setAccountId(accountId);

        return retryAsync(() => {
            return new Promise<void>((resolve, reject) => {
                this.accountClient.createAccount(req, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (resp.getResult() == accountpb.CreateAccountResponse.Result.EXISTS) {
                        reject(new AccountExists());
                        return;
                    }

                    resolve();
                })
            })
        }, ...this.strategies);
    }

    async getAccountInfo(account: PublicKey): Promise<accountpb.AccountInfo> {
        const accountId = new commonpb.StellarAccountId();
        accountId.setValue(account.stellarAddress());

        const req = new accountpb.GetAccountInfoRequest();
        req.setAccountId(accountId);

        return retryAsync(() => {
            return new Promise<accountpb.AccountInfo>((resolve, reject) => {
                this.accountClient.getAccountInfo(req, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (resp.getResult() == accountpb.GetAccountInfoResponse.Result.NOT_FOUND) {
                        reject(new AccountDoesNotExist());
                        return;
                    }

                    return resolve(resp.getAccountInfo())
                })
            });
        }, ...this.strategies);
    }

    async getTransaction(hash: Buffer): Promise<TransactionData|undefined> {
        const transactionHash = new commonpb.TransactionHash();
        transactionHash.setValue(hash);

        const req = new transactionpb.GetTransactionRequest();
        req.setTransactionHash(transactionHash);

        return retryAsync(() => {
            return new Promise<TransactionData|undefined>((resolve, reject) => {
                this.txClient.getTransaction(req, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const data = new TransactionData();
                    data.txHash = hash;

                    switch (resp.getState()) {
                        case transactionpb.GetTransactionResponse.State.UNKNOWN: {
                            resolve(undefined);
                            return;
                        }
                        case transactionpb.GetTransactionResponse.State.SUCCESS: {
                            const envelope = xdr.TransactionEnvelope.fromXDR(Buffer.from(resp.getItem()!.getEnvelopeXdr()!));

                            let type: TransactionType = TransactionType.UNKNOWN;
                            const memo = Memo.fromXdr(envelope.v0().tx().memo(), true);
                            if (memo) {
                                type = memo.TransactionType();
                            }

                            data.payments = paymentsFromEnvelope(envelope, type, resp.getItem()!.getInvoiceList());
                            break;
                        }
                        default: {
                            reject("unknown transaction state: " + resp.getState())
                            return
                        }
                    }

                    resolve(data)
                });
            });
        }, ...this.strategies);
    }

    async submitStellarTransaction(envelope: xdr.TransactionEnvelope, invoiceList?: commonpb.InvoiceList): Promise<SubmitStellarTransactionResult> {
        const req = new transactionpb.SubmitTransactionRequest();
        req.setEnvelopeXdr(envelope.toXDR());
        req.setInvoiceList(invoiceList);

        return retryAsync(() => {
            return new Promise<SubmitStellarTransactionResult>((resolve, reject) => {
                this.txClient.submitTransaction(req, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const result = new SubmitStellarTransactionResult();
                    result.TxHash = Buffer.from(resp.getHash()!.getValue()!);

                    switch (resp.getResult()) {
                        case transactionpb.SubmitTransactionResponse.Result.OK: {
                            break
                        }
                        case transactionpb.SubmitTransactionResponse.Result.REJECTED: {
                            throw new TransactionRejected();
                        }
                        case transactionpb.SubmitTransactionResponse.Result.INVOICE_ERROR: {
                            result.InvoiceErrors = resp.getInvoiceErrorsList();
                            break
                        }
                        case transactionpb.SubmitTransactionResponse.Result.FAILED: {
                            const resultXdr = xdr.TransactionResult.fromXDR(Buffer.from(resp.getResultXdr()));
                            result.Errors = errorsFromXdr(resultXdr);
                            break;
                        }
                        default:
                            reject("unexpected result from agora: " + resp.getResult());
                            return;
                    }

                    resolve(result);
                })
            })
        }, ...this.strategies);
    }
}
