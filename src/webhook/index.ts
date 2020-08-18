import http from "http";
import express from "express";
import { xdr, TransactionBuilder } from "stellar-base";
import { hmac, sha256 } from "hash.js";

import commonpb, { InvoiceList } from "@kinecosystem/agora-api/node/common/v3/model_pb";

import {
    PrivateKey,
    TransactionType,
    NetworkPasshrase,
    Environment,
    ReadOnlyPayment,
    paymentsFromEnvelope,
 }  from "..";


export const AGORA_HMAC_HEADER = "X-Agora-HMAC-SHA256".toLowerCase();
export const AGORA_USER_ID_HEADER = "X-Agora-User-Id".toLowerCase();
export const AGORA_USER_PASSKEY_HEADER = "X-Agora-User-Passkey".toLowerCase();

export interface Event {
    transaction_event: {
        kin_version:   number,
        tx_hash:       string,
        invoice_list?: commonpb.InvoiceList,

        stellar_event?: {
            envelope_xdr: string
            result_xdr:   string
        },
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
                return
            }

            callback(events);
            resp.sendStatus(200);
        } catch (err) {
            console.log(err)
            resp.sendStatus(500);
        }
    };
}

export class SignTransactionRequest {
    userId?:      string
    userPassKey?: string
    payments:     ReadOnlyPayment[]
    envelope:     xdr.TransactionEnvelope

    networkPassphrase: string

    constructor(envelope: xdr.TransactionEnvelope, payments: ReadOnlyPayment[], networkPassphrase: string, userId?: string, userPassKey?: string) {
        this.userId = userId;
        this.userPassKey = userPassKey
        this.payments = payments,

        this.envelope = envelope;
        this.networkPassphrase = networkPassphrase;
    }

    txHash(): Buffer {
        return TransactionBuilder.fromXDR(this.envelope, this.networkPassphrase).hash();
    }

}
export class SignTransactionResponse {
    rejected: boolean;
    envelope: xdr.TransactionEnvelope;
    signedEnvelope: xdr.TransactionEnvelope | undefined;
    invoiceErrors: InvoiceError[];
    networkPassphrase: string;

    constructor(envelope: xdr.TransactionEnvelope, networkPassphrase: string) {
        this.rejected = false;
        this.envelope = envelope;
        this.invoiceErrors = [];
        this.networkPassphrase = networkPassphrase;
    }

    isRejected(): boolean {
        return this.rejected
    }

    sign(key: PrivateKey): void {
        const builder = TransactionBuilder.fromXDR(this.envelope, this.networkPassphrase);
        builder.sign(key.kp);
        this.signedEnvelope = builder.toEnvelope();
    }
    reject(): void {
        this.rejected = true;
    }
    markAlreadyPaid(idx: number): void {
        this.invoiceErrors.push({
            operation_index: idx,
            reason: RejectionReason.AlreadyPaid,
        });
    }
    markWrongDestination(idx: number): void {
        this.invoiceErrors.push({
            operation_index: idx,
            reason: RejectionReason.WrongDestination,
        });
    }
    markSkuNotFound(idx: number): void {
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
    operation_index: number
    reason:          RejectionReason

    constructor() {
        this.operation_index = 0;
        this.reason = RejectionReason.None;
    }
}

export function SignTransactionHandler(env: Environment, callback: (req: SignTransactionRequest, resp: SignTransactionResponse) => void, secret?: string): express.RequestHandler<any> {
    let networkPassphrase: string
    switch (env) {
        case Environment.Test:
            networkPassphrase = NetworkPasshrase.Test;
            break;
        case Environment.Prod:
            networkPassphrase = NetworkPasshrase.Prod;
            break;
    }

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
                envelope_xdr: string
                invoice_list: string
            }

            const reqBody = <requestBody>req.body;
            if (!reqBody.envelope_xdr || typeof reqBody.envelope_xdr != "string") {
                resp.sendStatus(400)
                return
            }

            let userId: string | undefined;
            if (req.headers[AGORA_USER_ID_HEADER] && req.headers[AGORA_USER_ID_HEADER]!.length > 0) {
                userId = <string>req.headers[AGORA_USER_ID_HEADER];
            }

            let userPassKey: string | undefined;
            if (req.headers[AGORA_USER_PASSKEY_HEADER] && req.headers[AGORA_USER_PASSKEY_HEADER]!.length > 0) {
                userPassKey = <string>req.headers[AGORA_USER_PASSKEY_HEADER];
            }

            let invoiceList: commonpb.InvoiceList | undefined
            if (reqBody.invoice_list) {
                invoiceList = InvoiceList.deserializeBinary(Buffer.from(reqBody.invoice_list, "base64"));
            }

            const envelope = xdr.TransactionEnvelope.fromXDR(Buffer.from(reqBody.envelope_xdr, "base64"));
            const payments = paymentsFromEnvelope(envelope, TransactionType.Spend, invoiceList);
            signRequest = new SignTransactionRequest(envelope, payments, networkPassphrase, userId, userPassKey);
            signResponse = new SignTransactionResponse(envelope, networkPassphrase)
        } catch (err) {
            resp.sendStatus(400);
            return;
        }

        try {
            callback(signRequest, signResponse);
            if (signResponse.isRejected() || !signResponse.signedEnvelope) {
                resp.status(403).send({
                    invoice_errors: signResponse.invoiceErrors,
                });
            } else {
                resp.status(200).send({
                    envelope_xdr: signResponse.signedEnvelope!.toXDR("base64"),
                })
            }
        } catch (err) {
            console.log(err)
            resp.sendStatus(500);
        }
    };
}

function verifySignature(headers: http.IncomingHttpHeaders, body: any, secret: string): boolean {
    if (!headers[AGORA_HMAC_HEADER] || headers[AGORA_HMAC_HEADER]?.length == 0) {
        return false;
    }

    const rawSecret = Buffer.from(secret, "utf-8")
    const actual = Buffer.from(<string>headers[AGORA_HMAC_HEADER]!, 'base64').toString('hex');
    const expected = hmac(<any>sha256, rawSecret).update(body).digest('hex');
    return actual == expected;
}

