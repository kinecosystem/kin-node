import BigNumber from "bignumber.js";
import { xdr } from "stellar-base";

import commonpb from "agora-api/node/common/v3/model_pb";

import { Client } from "./client";
import { TransactionErrors } from "./errors";
import { PublicKey, PrivateKey } from "./keys";
import { Memo } from "./memo";

export {
    Client,
    TransactionErrors,
    PublicKey,
    PrivateKey,
    Memo,
}

export const MAX_TRANSACTION_TYPE = 3
export enum TransactionType {
    UNKNOWN = 0,
    Earn    = 1,
    Spend   = 2,
    P2P     = 3,
}

// Environment specifies the desired Kin environment to use.
export enum Environment {
    Prod,
    Test,
}
export enum NetworkPasshrase {
    Prod = "Kin Mainnet ; December 2018",
    Test = "Kin Testnet ; December 2018",
}

export function kinToQuarks(amount: BigNumber | string): BigNumber {
    return new BigNumber(amount).multipliedBy(1e5);
}

export function xdrInt64ToBigNumber(i64: xdr.Int64): BigNumber {
    const amount = BigNumber.sum(
        new BigNumber(i64.high).multipliedBy(Math.pow(2, 32)),
        new BigNumber(i64.low)
    );
    return amount;
}


// Invoice represents a transaction invoice for a single payment.
//
// See https://github.com/kinecosystem/agora-api for details.
export interface Invoice {
    Items: InvoiceItem[]
}

function protoToInvoice(invoice: commonpb.Invoice): Invoice {
    const result: Invoice = {
        Items: invoice.getItemsList().map(x => {
            const item: InvoiceItem = {
                title: x.getTitle(),
                amount: new BigNumber(x.getAmount()),
            };
            if (x.getDescription()) {
                item.description = x.getDescription();
            }
            if (x.getSku()) {
                item.sku = Buffer.from(x.getSku());
            }

            return item;
        })
    };

    return result;
}
export function invoiceToProto(invoice: Invoice): commonpb.Invoice {
    const result = new commonpb.Invoice();
    result.setItemsList(invoice.Items.map(x => {
        const item = new commonpb.Invoice.LineItem();
        item.setTitle(x.title);
        item.setAmount(x.amount.toString());

        if (x.description) {
            item.setDescription(x.description);
        }
        if (x.sku) {
            item.setSku(x.sku);
        }

        return item;
    }));
    return result;
}

// InvoiceItem is a single line item within an invoice.
//
// See https://github.com/kinecosystem/agora-api for details.
export interface InvoiceItem {
    title:        string
    description?: string
    amount:       BigNumber
    sku?:         Buffer
}

// Payment represents a payment that will be submitted.
export interface Payment {
    sender:      PrivateKey
    destination: PublicKey
    type:        TransactionType
    quarks:      BigNumber

    source?: PrivateKey

    invoice?: Invoice
    memo?:    string
}

// ReadOnlyPayment represents a payment where the sender's
// private key is not known. For example, when retrieved off of
// the block chain, or being used as a signing request.
export interface ReadOnlyPayment {
    sender:      PublicKey
    destination: PublicKey
    type:        TransactionType
    quarks:      string

    invoice?: Invoice
    memo?:    string
}

export function paymentsFromEnvelope(envelope: xdr.TransactionEnvelope, type: TransactionType, invoiceList?: commonpb.InvoiceList): ReadOnlyPayment[] {
    const payments: ReadOnlyPayment[] = [];

    if (invoiceList && invoiceList.getInvoicesList().length != envelope.v0().tx().operations().length) {
        throw new Error("provided invoice count does not match op count");
    }

    envelope.v0().tx().operations().map((op, i) => {
        // Currently we only support payment operations in this RPC.
		//
		// We could potentially expand this to CreateAccount functions,
		// as well as merge account. However, GetTransaction() is primarily
        // only used for payments
        if (op.body().switch() != xdr.OperationType.payment()) {
            return;
        }

        let sender: PublicKey;
        if (op.sourceAccount()) {
            sender = new PublicKey(op.sourceAccount()!.ed25519()!);
        } else {
            sender = new PublicKey(envelope.v0().tx().sourceAccountEd25519());
        }

        const p: ReadOnlyPayment = {
            sender: sender,
            destination: new PublicKey(op.body().paymentOp().destination().ed25519()),
            quarks: xdrInt64ToBigNumber(op.body().paymentOp().amount()).toString(),
            type: type,
        }

        if (invoiceList) {
            p.invoice = protoToInvoice(invoiceList.getInvoicesList()[i])
        } else if (envelope.v0().tx().memo().text()) {
            p.memo = envelope.v0().tx().memo().text().toString();
        }

        payments.push(p);
    });

    return payments
}

// TransactionData contains both metadata and payment data related to
// a blockchain transaction.
export class TransactionData {
    txHash:   Buffer
    payments: ReadOnlyPayment[]
    errors?:   TransactionErrors

    constructor() {
        this.txHash = Buffer.alloc(0);
        this.payments = new Array<ReadOnlyPayment>()
    }
}

// EarnBatch is a batch of earn payments to be sent.
export interface EarnBatch {
    sender:  PrivateKey
    source?: PrivateKey

    memo?: string

    earns: Earn[]
}

// EarnReceiver represents a receiver in an earn batch.
export interface Earn {
    destination: PublicKey
    quarks:      BigNumber
    invoice?:    Invoice
}

// EarnBatchResult contains the results from an earn batch.
export class EarnBatchResult {
    succeeded: EarnResult[]
    failed:    EarnResult[]
    error?:    Error

    constructor() {
        this.succeeded = [];
        this.failed = [];
    }
}

// EarnResult contains the result of a submitted earn.
export interface EarnResult {
    txHash?:  Buffer
    receiver: Earn
    error?:   Error
}
