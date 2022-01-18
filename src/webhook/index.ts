import commonpb, { InvoiceList } from "@kin-beta/agora-api/node/common/v3/model_pb";
import { Account, Transaction } from "@solana/web3.js";
import express from "express";
import { hmac, sha256 } from "hash.js";
import http from "http";
import {
    Creation,
    Environment,
    parseTransaction,
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

export class CreateAccountRequest {
    userId?:      string;
    userPassKey?: string;
    creation:     Creation;
    transaction:  Transaction;

    constructor(
        creation: Creation, transaction: Transaction, userId?: string, userPassKey?: string
    ) {
        this.userId = userId;
        this.userPassKey = userPassKey;
        this.creation = creation;
        this.transaction = transaction;
    }
}

export class CreateAccountResponse {
    transaction: Transaction;
    rejected:    boolean;

    constructor(transaction: Transaction) {
        this.transaction = transaction;
        this.rejected = false;
    }

    isRejected(): boolean {
        return this.rejected;
    }

    sign(key: PrivateKey): void {
        if (this.transaction.signatures[0].publicKey.toBuffer().equals(key.publicKey().buffer)) {
            this.transaction.partialSign(new Account(key.secretKey()));
        }
    }

    reject(): void {
        this.rejected = true;
    }
}

export function CreateAccountHandler(env: Environment, callback: (req: CreateAccountRequest, resp: CreateAccountResponse) => void, secret?: string): express.RequestHandler<any> {
    return (req: express.Request<any>, resp: express.Response<any>, next: express.NextFunction) => {
        if (secret) {
            if (!verifySignature(req.headers, JSON.stringify(req.body), secret)) {
                resp.sendStatus(401);
                return;
            }
        }

        let createRequest: CreateAccountRequest;
        let createResponse: CreateAccountResponse;

        try {
            interface requestBody {
                solana_transaction: string
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

            if (!reqBody.solana_transaction || typeof reqBody.solana_transaction != "string") {
                resp.sendStatus(400);
                return;
            }

            const txBytes = Buffer.from(reqBody.solana_transaction, "base64");
            const tx = Transaction.from(txBytes);
            const [creations, payments] = parseTransaction(tx);
            if (payments.length !== 0) {
                resp.sendStatus(400);
                return;
            }
            if (creations.length !== 1) {
                resp.sendStatus(400);
                return;
            }

            createRequest = new CreateAccountRequest(creations[0], tx, userId, userPassKey);
            createResponse = new CreateAccountResponse(tx);
        } catch (err) {
            resp.sendStatus(400);
            return;
        }

        try {
            callback(createRequest, createResponse);
            if (createResponse.isRejected()) {
                resp.sendStatus(403);
                return;
            }

            const sig = createResponse.transaction.signature;
            if (sig && sig != Buffer.alloc(64).fill(0)) {
                resp.status(200).send({
                    signature: sig.toString('base64')
                });
                return;
            }

            return resp.sendStatus(200);
        } catch (err) {
            console.log(err);
            resp.sendStatus(500);
        }
    };
}

export class SignTransactionRequest {
    userId?:      string;
    userPassKey?: string;
    creations:    Creation[];
    payments:     ReadOnlyPayment[];
    transaction:  Transaction;

    constructor(
        creations: Creation[], payments: ReadOnlyPayment[], transaction: Transaction, userId?: string, userPassKey?: string
    ) {
        this.userId = userId;
        this.userPassKey = userPassKey;
        this.creations = creations;
        this.payments = payments;

        this.transaction = transaction;
    }

    txId(): Buffer | undefined {
        return this.transaction.signature ? this.transaction.signature : undefined;
    }
}

export class SignTransactionResponse {
    transaction:  Transaction;
    rejected: boolean;
    invoiceErrors: InvoiceError[];

    constructor(transaction: Transaction) {
        this.transaction = transaction;
        this.rejected = false;
        this.invoiceErrors = [];
    }

    isRejected(): boolean {
        return this.rejected;
    }

    sign(key: PrivateKey): void {
        if (this.transaction.signatures[0].publicKey.toBuffer().equals(key.publicKey().buffer)) {
            this.transaction.partialSign(new Account(key.secretKey()));
        }
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
            const tx = Transaction.from(txBytes);
            const [creations, payments] = parseTransaction(tx, invoiceList);
            signRequest = new SignTransactionRequest(creations, payments, tx, userId, userPassKey);
            signResponse = new SignTransactionResponse(tx);
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
                return;
            }

            const sig = signResponse.transaction.signature;
            if (sig && sig != Buffer.alloc(64).fill(0)) {
                resp.status(200).send({
                    signature: sig.toString('base64')
                });
                return;
            }

            return resp.sendStatus(200);
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
