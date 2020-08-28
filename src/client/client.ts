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

import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import accountgrpc from "@kinecosystem/agora-api/node/account/v3/account_service_grpc_pb";
import transactionpb from "@kinecosystem/agora-api/node/transaction/v3/transaction_service_pb";
import transactiongrpc from "@kinecosystem/agora-api/node/transaction/v3/transaction_service_grpc_pb";

import {
    PrivateKey,
    PublicKey,
    Memo as KinMemo,
    TransactionType,
    NetworkPasshrase,
} from "../";
import { InternalClient, SubmitStellarTransactionResult } from "./";
import { Environment, TransactionData, Payment, EarnBatch, EarnBatchResult, invoiceToProto } from "../";
import { AlreadyPaid, SkuNotFound, WrongDestination, BadNonce } from "../errors";
import { retryAsync, limit, retriableErrors, backoffWithJitter, binaryExpotentialDelay, nonRetriableErrors } from "../retry";
import { InternalClientConfig } from "./internal";

export interface ClientConfig {
    endpoint?:      string
    internal?:      InternalClient
    accountClient?: accountgrpc.AccountClient
    txClient?:      transactiongrpc.TransactionClient

    appIndex?: number
    retryConfig?: RetryConfig

    // An optional whitelist key to sign every transaction with.
    whitelistKey?: PrivateKey
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
}

// Client is the primary class that should be used for interacting with kin.
//
// Client abstracts away the underlying blockchain implementations, allowing for
// easier upgrades in the future.
export class Client {
    internal:          InternalClient
    networkPassphrase: string
    maxNonceRetries:   number
    appIndex?:         number
    whitelistKey?:     PrivateKey

    constructor(env: Environment, conf?: ClientConfig) {
        if (conf?.endpoint) {
            if (conf?.internal) {
                throw new Error("cannot specify both endpoint and internal client");
            }
            if (conf?.accountClient || conf?.txClient) {
                throw new Error("cannot specify both endpoint and gRPC clients");
            }
        } else if (conf?.internal) {
            if (conf?.accountClient || conf?.txClient) {
                throw new Error("cannot specify both internal and gRPC clients");
            }
        } else if ((conf?.accountClient == undefined) !=  (conf?.txClient == undefined)) {
            throw new Error("either both or neither gRPC clients must be set");
        }

        let defaultEndpoint: string;
        switch (env) {
            case Environment.Test:
                this.networkPassphrase = NetworkPasshrase.Test;
                defaultEndpoint = "api.agorainfra.dev:443";
                break;
            case Environment.Prod:
                this.networkPassphrase = NetworkPasshrase.Prod;
                defaultEndpoint = "api.agorainfra.net:443";
                break;
            default:
                throw new Error("unsupported env:" + env);
        }

        if (conf) {
            this.appIndex = conf.appIndex;
            this.whitelistKey = conf.whitelistKey;
        }
        if (conf?.retryConfig?.maxNonceRefreshes) {
            this.maxNonceRetries = conf?.retryConfig?.maxNonceRefreshes;
        } else {
            this.maxNonceRetries = defaultRetryConfig.maxNonceRefreshes;
        }
        if (conf?.internal) {
            this.internal = conf.internal;
            return;
        }

        const internalConf: InternalClientConfig = {
            endpoint: conf?.endpoint,
            accountClient: conf?.accountClient,
            txClient: conf?.txClient,
        }
        if (!internalConf.endpoint && !internalConf.accountClient && !internalConf.endpoint) {
            internalConf.endpoint = defaultEndpoint;
        }

        let retryConfig: RetryConfig = Object.assign({}, defaultRetryConfig);
        if (conf && conf.retryConfig) {
            retryConfig = conf.retryConfig!;
        }
        internalConf.strategies = [
            limit(retryConfig.maxRetries),
            backoffWithJitter(binaryExpotentialDelay(retryConfig.minDelaySeconds), retryConfig.maxDelaySeconds, 0.1),
        ];

        this.internal = new InternalClient(internalConf);
    }

    // createAccount creates a new Kin account.
    //
    // Promise.reject(new AccountExists()) is called if
    // the account already exists.
    async createAccount(key: PrivateKey): Promise<void> {
        return this.internal.createStellarAccount(key);
    }

    // getBalance retrieves the balance for an account.
    //
    // Promise.reject(new AccountDoesNotExist()) is called if
    // the specified account does not exist.
    async getBalance(account: PublicKey): Promise<BigNumber> {
        return this.internal.getAccountInfo(account)
            .then(info => new BigNumber(info.getBalance()));
    }

    // getTransaction retrieves the TransactionData for a txHash.
    //
    // If no transaction data currently exists, Promise.resolve(undefined)
    // is called. In this state, the transaction may or may not resolve in
    // the future, it is simply unknown _at this time_.
    async getTransaction(txHash: Buffer): Promise<TransactionData|undefined> {
        return this.internal.getTransaction(txHash);
    }

    // submitPayment submits a payment.
    //
    // If the payment has an invoice, an app index _must_ be set.
    // If the payment has a memo, an invoice cannot also be provided.
    async submitPayment(payment: Payment): Promise<Buffer> {
        if (payment.invoice && !this.appIndex) {
            return Promise.reject("cannot submit payment with invoices without an app index");
        }

        let signers: PrivateKey[];
        if (payment.source) {
            signers = [payment.source, payment.sender];
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
                fk = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex")
            }

            const kinMemo = KinMemo.new(1, payment.type, this.appIndex!, fk)
            memo = new Memo(MemoHash, kinMemo.buffer);
        }

        const op = Operation.payment({
            source: payment.sender.publicKey().stellarAddress(),
            destination: payment.destination.stellarAddress(),
            asset: Asset.native(),
            // In Kin, the base currency has been 'scaled' by
            // a factor of 100 from stellar. That is, 1 Kin is 100x
            // 1 XLM, and the minimum amount is 1e-5 instead of 1e-7.
            //
            // Since js-stellar's amount here is an XLM (equivalent to Kin),
            // we need to convert it to a quark (divide by 1e5), and then also
            // account for the 100x scaling factor. 1e5 / 100 = 1e7.
            amount: payment.quarks.dividedBy(1e7).toFixed(7),
        });

        const result = await this.signAndSubmit(signers, [op], memo, invoiceList);
        if (result.Errors && result.Errors.OpErrors) {
            if (result.Errors.OpErrors.length != 1) {
                throw new Error("invalid number of operation errors. expected 0 or 1");
            }

            throw result.Errors.OpErrors[0];
        }
        if (result.Errors && result.Errors.TxError) {
            throw result.Errors.TxError;
        }
        if (result.InvoiceErrors && result.InvoiceErrors.length > 0) {
            if (result.InvoiceErrors.length != 1) {
                throw new Error("invalid number of invoice errors. expected 0 or 1");
            }

            switch (result.InvoiceErrors[0].getReason()) {
                case transactionpb.SubmitTransactionResponse.InvoiceError.Reason.ALREADY_PAID:
                    throw new AlreadyPaid();
                case transactionpb.SubmitTransactionResponse.InvoiceError.Reason.WRONG_DESTINATION:
                    throw new WrongDestination();
                case transactionpb.SubmitTransactionResponse.InvoiceError.Reason.SKU_NOT_FOUND:
                    throw new SkuNotFound();
                default:
                    throw new Error("unknown invoice error");
            }
        }

        return Promise.resolve(result.TxHash);
    }

    // submitEarnBatch submits an EarnBatch.
    //
    // Depending on the size of the EarnBatch, the client may break up
    // the batch into multiple sub-batches. As a result, it is possible
    // for partial failures to occur.
    //
    // If partial failures cannot be tolerated, then submitPayment with type Earn,
    // or submitBatch with a batch size of 1 should be used.
    async submitEarnBatch(batch: EarnBatch): Promise<EarnBatchResult> {
        if (batch.memo) {
            for (const r of batch.earns) {
                if (r.invoice) {
                    throw new Error("cannot have invoice set when memo is set");
                }
            }
        } else {
            if (batch.earns[0].invoice && !this.appIndex) {
                throw new Error("cannot submit earn batch without an app index");
            }

            for (let i = 0; i < batch.earns.length - 1; i++) {
                if ((batch.earns[i].invoice == undefined) != (batch.earns[i+1].invoice == undefined)) {
                    throw new Error("either all or none of the earns should have an invoice set");
                }
            }
        }

        // Stellar has an operation batch size of 100, so we break apart the EarnBatch into
        // sub-batches of 100 each.
        const batches: EarnBatch[] = [];
        for (let start = 0; start < batch.earns.length; start += 100) {
            const end = Math.min(start+100, batch.earns.length);
            batches.push({
                sender: batch.sender,
                source: batch.source,
                memo: batch.memo,
                earns: batch.earns.slice(start, end),
            });
        }

        const batchResult = new EarnBatchResult();

        let unprocessedBatch = 0;
        for (let i = 0; i < batches.length; i++) {
            const b = batches[i];

            let result: SubmitStellarTransactionResult;
            try {
                result = await this.submitSingleEarnBatch(b);
            } catch (err) {
                for (let j = 0; j < b.earns.length; j++) {
                    batchResult.failed.push({
                        earn: b.earns[j],
                        error: err,
                    });
                }
                break;
            }

            if (!result.Errors || !result.Errors.TxError) {
                for (const r of b.earns) {
                    batchResult.succeeded.push({
                        txHash: result.TxHash,
                        earn: r,
                    });
                }

                unprocessedBatch = i + 1;
                continue
            }

            // At this point, we consider the batch failed.

            // If there was operation level errors, we set the individual results
            // for this batch, and then mark the rest of the earns as aborted.
            if (result.Errors.OpErrors) {
                for (let j = 0; j < result.Errors.OpErrors.length; j++) {
                    batchResult.failed.push({
                        txHash: result.TxHash,
                        earn: b.earns[j],
                        error: result.Errors.OpErrors[j],
                    });
                }
            } else {
                for (let j = 0; j < b.earns.length; j++) {
                    batchResult.failed.push({
                        txHash: result.TxHash,
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
                })
            }
        }

        return Promise.resolve(batchResult);
    }

    private async submitSingleEarnBatch(batch: EarnBatch): Promise<SubmitStellarTransactionResult> {
        let signers: PrivateKey[];
        if (batch.source) {
            signers = [batch.source, batch.sender];
        } else {
            signers = [batch.sender];
        }

        const ops: xdr.Operation[] = [];
        for (const e of batch.earns) {
            ops.push(Operation.payment({
                source: batch.sender.publicKey().stellarAddress(),
                destination: e.destination.stellarAddress(),
                asset: Asset.native(),
                // In Kin, the base currency has been 'scaled' by
                // a factor of 100 from stellar. That is, 1 Kin is 100x
                // 1 XLM, and the minimum amount is 1e-5 instead of 1e-7.
                //
                // Since js-stellar's amount here is in XLM (equivalent to Kin),
                // we need to convert it to a quark (divide by 1e5), and then also
                // account for the 100x scaling factor. 1e5 / 100 = 1e7.
                amount: e.quarks.dividedBy(1e7).toFixed(7),
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
                    throw new Error("either all or none of the earns should have an invoice");
                }

                const serialized = invoiceList.serializeBinary();
                fk = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex")
            } else {
                invoiceList = undefined;
            }

            const kinMemo = KinMemo.new(1, TransactionType.Earn, this.appIndex!, fk)
            memo = new Memo(MemoHash, kinMemo.buffer);
        }

        const result = await this.signAndSubmit(signers, ops, memo, invoiceList);
        if (result.InvoiceErrors) {
            throw new Error("unexpected invoice errors present");
        }

        return Promise.resolve(result);
    }

    private async signAndSubmit(signers: PrivateKey[],  operations: xdr.Operation[], memo?: Memo, invoiceList?: commonpb.InvoiceList):  Promise<SubmitStellarTransactionResult> {
        let result: SubmitStellarTransactionResult;
        const fn = async () => {
            const accountInfo = await this.internal.getAccountInfo(signers[0].publicKey());
            const builder = new TransactionBuilder(
                new Account(signers[0].publicKey().stellarAddress(), accountInfo.getSequenceNumber()),
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
                tx.sign(this.whitelistKey.kp);
            }

            result = await this.internal.submitStellarTransaction(tx.toEnvelope(), invoiceList);
            if (result.Errors && result.Errors.TxError instanceof BadNonce) {
                throw new BadNonce();
            }

            return result;
        };

        return retryAsync(fn, limit(this.maxNonceRetries), retriableErrors(BadNonce)).catch(err => {
            if (err instanceof BadNonce) {
                return Promise.resolve(result);
            }
            return Promise.reject(err);
        })
    }
}
