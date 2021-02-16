import commonpb, { InvoiceList } from "@kinecosystem/agora-api/node/common/v3/model_pb";
import { Transaction as SolanaTransaction } from "@solana/web3.js";
import express from "express";
import { hmac, sha256 } from "hash.js";
import http from "http";
import { xdr } from "stellar-base";
import {
    Environment,
    paymentsFromTransaction,
    PrivateKey,
    ReadOnlyPayment
} from "..";


export const AGORA_HMAC_HEADER = "X-Agora-HMAC-SHA256".toLowerCase();
export const AGORA_USER_ID_HEADER = "X-Agora-User-Id".toLowerCase();
export const AGORA_USER_PASSKEY_HEADER = "X-Agora-User-Passkey".toLowerCase();

export interface Event {
    transaction_event: {
        tx_id: string,
        invoice_list?: commonpb.InvoiceList,
        solana_event?: {
            transaction: string,
            tx_error?: string,
            tx_error_raw?: string
        }
    }
}

export function EventsHandler(callback: (events: Event[]) => void, secret?: string): express.RequestHandler<any> {
    return (req: express.Request<any>, resp: express.Response<any>, next: express.NextFunction) => {
        if (secret) {
            if (!verifySignature(req.headers, JSON.stringify(req.body), secret)) {
                resp.sendStatus(401);
                return;
            }
        }

        try {
            const events = <Event[]>req.body;
            if (events.length == undefined || events.length == 0) {
                resp.sendStatus(400);
                return;
            }

            callback(events);
            resp.sendStatus(200);
        } catch (err) {
            console.log(err);
            resp.sendStatus(500);
        }
    };
}

export class SignTransactionRequest {
    userId?:            string;
    userPassKey?:       string;
    payments:           ReadOnlyPayment[];
    solanaTransaction: SolanaTransaction;

    constructor(
        payments: ReadOnlyPayment[], transaction: SolanaTransaction, userId?: string, userPassKey?: string
    ) {
        this.userId = userId;
        this.userPassKey = userPassKey;
        this.payments = payments;

        this.solanaTransaction = transaction;
    }

    txId(): Buffer | undefined {
        return this.solanaTransaction.signature;
    }
}

export class SignTransactionResponse {
    rejected: boolean;
    invoiceErrors: InvoiceError[];

    constructor() {
        this.rejected = false;
        this.invoiceErrors = [];
    }

    isRejected(): boolean {
        return this.rejected;
    }

    sign(key: PrivateKey): void {
        // TODO: add solana transaction signing for subsidization
    }

    reject(): void {
        this.rejected = true;
    }

    markAlreadyPaid(idx: number): void {
        this.reject();
        this.invoiceErrors.push({
            operation_index: idx,
            reason: RejectionReason.AlreadyPaid,
        });
    }

    markWrongDestination(idx: number): void {
        this.reject();
        this.invoiceErrors.push({
            operation_index: idx,
            reason: RejectionReason.WrongDestination,
        });
    }

    markSkuNotFound(idx: number): void {
        this.reject();
        this.invoiceErrors.push({
            operation_index: idx,
            reason: RejectionReason.SkuNotFound,
        });
    }
}

export enum RejectionReason {
    None             = "",
    AlreadyPaid      = "already_paid",
    WrongDestination = "wrong_destination",
    SkuNotFound      = "sku_not_found",
}

export class InvoiceError {
    operation_index: number;
    reason:          RejectionReason;

    constructor() {
        this.operation_index = 0;
        this.reason = RejectionReason.None;
    }
}

export function SignTransactionHandler(env: Environment, callback: (req: SignTransactionRequest, resp: SignTransactionResponse) => void, secret?: string): express.RequestHandler<any> {
    return (req: express.Request<any>, resp: express.Response<any>, next: express.NextFunction) => {
        if (secret) {
            if (!verifySignature(req.headers, JSON.stringify(req.body), secret)) {
                resp.sendStatus(401);
                return;
            }
        }

        let signRequest: SignTransactionRequest;
        let signResponse: SignTransactionResponse;

        try {
            interface requestBody {
                solana_transaction: string
                invoice_list: string
            }

            const reqBody = <requestBody>req.body;

            let userId: string | undefined;
            if (req.headers[AGORA_USER_ID_HEADER] && req.headers[AGORA_USER_ID_HEADER]!.length > 0) {
                userId = <string>req.headers[AGORA_USER_ID_HEADER];
            }

            let userPassKey: string | undefined;
            if (req.headers[AGORA_USER_PASSKEY_HEADER] && req.headers[AGORA_USER_PASSKEY_HEADER]!.length > 0) {
                userPassKey = <string>req.headers[AGORA_USER_PASSKEY_HEADER];
            }

            let invoiceList: commonpb.InvoiceList | undefined;
            if (reqBody.invoice_list) {
                invoiceList = InvoiceList.deserializeBinary(Buffer.from(reqBody.invoice_list, "base64"));
            }

            if (!reqBody.solana_transaction || typeof reqBody.solana_transaction != "string") {
                resp.sendStatus(400);
                return;
            }

            const txBytes = Buffer.from(reqBody.solana_transaction, "base64");
            const tx = SolanaTransaction.from(txBytes);
            const payments = paymentsFromTransaction(tx, invoiceList);
            signRequest = new SignTransactionRequest(payments, tx, userId, userPassKey);
            signResponse = new SignTransactionResponse();
        } catch (err) {
            resp.sendStatus(400);
            return;
        }

        try {
            callback(signRequest, signResponse);
            if (signResponse.isRejected()) {
                resp.status(403).send({
                    invoice_errors: signResponse.invoiceErrors,
                });
            } else {
                resp.status(200).send({});
            }
        } catch (err) {
            console.log(err);
            resp.sendStatus(500);
        }
    };
}

function verifySignature(headers: http.IncomingHttpHeaders, body: any, secret: string): boolean {
    if (!headers[AGORA_HMAC_HEADER] || headers[AGORA_HMAC_HEADER]?.length == 0) {
        return false;
    }

    const rawSecret = Buffer.from(secret, "utf-8");
    const actual = Buffer.from(<string>headers[AGORA_HMAC_HEADER]!, 'base64').toString('hex');
    const expected = hmac(<any>sha256, rawSecret).update(body).digest('hex');
    return actual == expected;
}
