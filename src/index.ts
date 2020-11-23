import BigNumber from "bignumber.js";
import { xdr } from "stellar-base";

import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import commonpbv4 from "@kinecosystem/agora-api/node/common/v4/model_pb";
import txpbv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_pb";
import { SystemInstruction, Transaction as SolanaTransaction } from "@solana/web3.js";

import { Client } from "./client";
import { errorsFromProto, TransactionErrors } from "./errors";
import { PrivateKey, PublicKey } from "./keys";
import { Memo } from "./memo";
import { MemoInstruction, MemoProgram } from "./solana/memo-program";
import { TokenInstruction, TransferParams } from "./solana/token-program";

export {
    Client,
    TransactionErrors,
    PublicKey,
    PrivateKey,
    Memo,
};

export const MAX_TRANSACTION_TYPE = 3;
export enum TransactionType {
    Unknown = -1,
    None = 0,
    Earn = 1,
    Spend = 2,
    P2P = 3,
}

export enum TransactionState {
    Unknown = 0,
    Success = 1,
    Failed = 2,
    Pending = 3,
}

export function transactionStateFromProto(state: txpbv4.GetTransactionResponse.State): TransactionState {
    switch (state) {
        case txpbv4.GetTransactionResponse.State.SUCCESS:
            return TransactionState.Success;
        case txpbv4.GetTransactionResponse.State.FAILED:
            return TransactionState.Failed;
        case txpbv4.GetTransactionResponse.State.PENDING:
            return TransactionState.Pending;
        default:
            return TransactionState.Unknown;
    }
}

// Commitment is used to indicate to Solana nodes which bank state to query.
// See: https://docs.solana.com/apps/jsonrpc-api#configuring-state-commitment
export enum Commitment {
    // The node will query its most recent block.
    Recent = 0,
    // The node will query the most recent block that has been voted on by supermajority of the cluster.
    Single = 1,
    // The node will query the most recent block having reached maximum lockout on this node.
    Root = 2,
    // The node will query the most recent block confirmed by supermajority of the cluster as having reached maximum lockout.
    Max = 3,
}

export function commitmentToProto(commitment: Commitment): commonpbv4.Commitment {
    switch (commitment) {
        case Commitment.Single:
            return commonpbv4.Commitment.SINGLE;
        case Commitment.Recent:
            return commonpbv4.Commitment.RECENT;
        case Commitment.Root:
            return commonpbv4.Commitment.ROOT;
        case Commitment.Max:
            return commonpbv4.Commitment.MAX;
        default:
            throw new Error("unexpected commitment value: " + commitment);
    }
}

// AccountResolution is used to indicate which type of account resolution should be used if a transaction on Kin 4 fails due to 
// an account being unavailable.
export enum AccountResolution {
    // No account resolution will be used.
    Exact = 0,
    // When used for a sender key, in a payment or earn request, if Agora is able to resolve the original sender public key to 
    // a set of token accounts, the original sender will be used as the owner in the Solana transfer instruction and the first
    // resolved token account will be used as the sender.
    //
    // When used for a destination key in a payment or earn request, if Agora is able to resolve the destination key to a set 
    // of token accounts, the first resolved token account will be used as the destination in the Solana transfer instruction.
    Preferred = 1,
}

// Environment specifies the desired Kin environment to use.
export enum Environment {
    Prod,
    Test,
}
export enum NetworkPasshrase {
    Prod = "Kin Mainnet ; December 2018",
    Test = "Kin Testnet ; December 2018",
    Kin2Prod = "Public Global Kin Ecosystem Network ; June 2018",
    Kin2Test = "Kin Playground Network ; June 2018",
}

export const KinAssetCode = "KIN";
const KinAssetCodeBuffer = Buffer.from([75, 73, 78, 0]);

export enum Kin2Issuers {
    Prod = "GDF42M3IPERQCBLWFEZKQRK77JQ65SCKTU3CW36HZVCX7XX5A5QXZIVK",
    Test = "GBC3SG6NGTSZ2OMH3FFGB7UVRQWILW367U4GSOOF4TFSZONV42UJXUH7",
}

// kinToQuarks converts a string representation of kin
// to the quark value.
//
// If the provided kin amount contains more than 5 decimal
// places (i.e. an inexact number of quarks), additional
// decimal places will be ignored.
//
// For example, passing in a value of "0.000009" will result
// in a value of 0 quarks being returned.
//
export function kinToQuarks(amount: string): BigNumber {
    const b = new BigNumber(amount).decimalPlaces(5, BigNumber.ROUND_DOWN);
    return b.multipliedBy(1e5);
}

export function quarksToKin(amount: BigNumber | string): string {
    return new BigNumber(amount).dividedBy(1e5).toString();
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
    title: string
    description?: string
    amount: BigNumber
    sku?: Buffer
}

// Payment represents a payment that will be submitted.
export interface Payment {
    sender: PrivateKey
    destination: PublicKey
    type: TransactionType
    quarks: BigNumber

    channel?: PrivateKey
    subsidizer?: PrivateKey

    invoice?: Invoice
    memo?: string
}

// ReadOnlyPayment represents a payment where the sender's
// private key is not known. For example, when retrieved off of
// the block chain, or being used as a signing request.
export interface ReadOnlyPayment {
    sender: PublicKey
    destination: PublicKey
    type: TransactionType
    quarks: string

    invoice?: Invoice
    memo?: string
}

export function paymentsFromEnvelope(envelope: xdr.TransactionEnvelope, type: TransactionType, invoiceList?: commonpb.InvoiceList, kinVersion?: number): ReadOnlyPayment[] {
    const payments: ReadOnlyPayment[] = [];

    if (!kinVersion) {
        kinVersion = 3;
    }

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

        if (kinVersion === 2) {
            const assetName = op.body().paymentOp().asset().switch().name;
            if (
                assetName !== "assetTypeCreditAlphanum4" ||
                !op.body().paymentOp().asset().alphaNum4().assetCode().equals(KinAssetCodeBuffer)
            ) {
                // Only Kin payment operations are supported in this RPC.
                return;
            }
        }

        let sender: PublicKey;
        if (op.sourceAccount()) {
            sender = new PublicKey(op.sourceAccount()!.ed25519()!);
        } else {
            sender = new PublicKey(envelope.v0().tx().sourceAccountEd25519());
        }

        let quarks: string;
        if (kinVersion === 2) {
            // The smallest denomination on Kin 2 is 1e-7, which is smaller than quarks (1e-5) by 1e2. Therefore, when
            // parsing envelope amounts, we divide by 1e2 to get the amount in quarks.
            quarks = xdrInt64ToBigNumber(op.body().paymentOp().amount()).dividedBy(1e2).toString();
        } else {
            quarks = xdrInt64ToBigNumber(op.body().paymentOp().amount()).toString();
        }
        const p: ReadOnlyPayment = {
            sender: sender,
            destination: new PublicKey(op.body().paymentOp().destination().ed25519()),
            quarks: quarks,
            type: type,
        };

        if (invoiceList) {
            p.invoice = protoToInvoice(invoiceList.getInvoicesList()[i]);
        } else if (envelope.v0().tx().memo().switch() === xdr.MemoType.memoText()) {
            p.memo = envelope.v0().tx().memo().text().toString();
        }

        payments.push(p);
    });

    return payments;
}

export function paymentsFromTransaction(transaction: SolanaTransaction, invoiceList?: commonpb.InvoiceList): ReadOnlyPayment[] {
    const payments: ReadOnlyPayment[] = [];
    let transferStartIndex = 0;

    let agoraMemo: Memo | undefined;
    let textMemo: string | undefined;
    if (transaction.instructions[0].programId.equals(MemoProgram.programId)) {
        const memoParams = MemoInstruction.decodeMemo(transaction.instructions[0]);
        transferStartIndex = 1;

        try {
            agoraMemo = Memo.fromB64String(memoParams.data, false);
        } catch (e) {
            // not a valid agora memo
            textMemo = memoParams.data;
        }
    }

    const transferCount = transaction.instructions.length - transferStartIndex;
    if (invoiceList && invoiceList?.getInvoicesList().length !== transferCount) {
        throw new Error("number of invoices does not match number of payments");
    }

    transaction.instructions.slice(transferStartIndex).forEach((instruction, i) => {
        let transferParams : TransferParams;
        try {
            transferParams = TokenInstruction.decodeTransfer(instruction);
        } catch (error) {
            return;
        }

        const p : ReadOnlyPayment = {
            sender: new PublicKey(transferParams.source.toBuffer()),
            destination: new PublicKey(transferParams.dest.toBuffer()),
            type: agoraMemo ? agoraMemo.TransactionType() : TransactionType.Unknown,
            quarks: transferParams.amount.toString(),
        };
        if (invoiceList) {
            p.invoice = protoToInvoice(invoiceList.getInvoicesList()[i]);
        } else if (textMemo) {
            p.memo = textMemo;
        }

        payments.push(p);
    });

    return payments;
}

// TransactionData contains both metadata and payment data related to
// a blockchain transaction.
export class TransactionData {
    txId: Buffer;
    txState: TransactionState;
    payments: ReadOnlyPayment[];
    errors?: TransactionErrors;

    constructor() {
        this.txId = Buffer.alloc(0);
        this.txState = TransactionState.Unknown;
        this.payments = new Array<ReadOnlyPayment>();
    }
}

export function txDataFromProto(item: txpbv4.HistoryItem, state: txpbv4.GetTransactionResponse.State): TransactionData {
    const data = new TransactionData();
    data.txId = Buffer.from(item.getTransactionId()!.getValue());
    data.txState = transactionStateFromProto(state);

    const invoiceList = item.getInvoiceList();
    if (invoiceList && invoiceList.getInvoicesList().length !== item.getPaymentsList().length) {
        throw new Error("number of invoices does not match number of payments");
    }

    let txType: TransactionType = TransactionType.Unknown;
    let stringMemo: string | undefined;
    if (item.getSolanaTransaction()) {
        const val = item.getSolanaTransaction()!.getValue_asU8();
        const solanaTx = SolanaTransaction.from(Buffer.from(val));
        if (solanaTx.instructions[0].programId.equals(MemoProgram.programId)) {
            const memoParams = MemoInstruction.decodeMemo(solanaTx.instructions[0]);
            let agoraMemo: Memo | undefined;
            try {
                agoraMemo = Memo.fromB64String(memoParams.data, false);
                txType = agoraMemo!.TransactionType();
            } catch (e) {
                // not a valid agora memo
                stringMemo = memoParams.data;
            }
        }
    }
    else if (item.getStellarTransaction()?.getEnvelopeXdr()) {
        const envelope = xdr.TransactionEnvelope.fromXDR(Buffer.from(item.getStellarTransaction()!.getEnvelopeXdr()));
        const agoraMemo = Memo.fromXdr(envelope.v0().tx().memo(), true);
        if (agoraMemo) {
            txType = agoraMemo.TransactionType();
        } else if (envelope.v0().tx().memo().switch() === xdr.MemoType.memoText()) {
            stringMemo = envelope.v0().tx().memo().text().toString();
        }
    }

    const payments: ReadOnlyPayment[] = [];
    item.getPaymentsList().forEach((payment, i) => {
        const p: ReadOnlyPayment = {
            sender: new PublicKey(Buffer.from(payment.getSource()!.getValue_asU8())),
            destination: new PublicKey(Buffer.from(payment.getDestination()!.getValue_asU8())),
            quarks: new BigNumber(payment.getAmount()).toString(),
            type: txType
        };
        if (item.getInvoiceList()) {
            p.invoice = protoToInvoice(item.getInvoiceList()!.getInvoicesList()[i]);
        } else if (stringMemo) {
            p.memo = stringMemo;
        }
        payments.push(p);
    });
    data.payments = payments;

    if (item.getTransactionError()) {
        data.errors = errorsFromProto(item.getTransactionError()!);
    }

    return data;
}

// EarnBatch is a batch of earn payments to be sent.
export interface EarnBatch {
    sender: PrivateKey
    channel?: PrivateKey
    subsidizer?: PrivateKey

    memo?: string

    earns: Earn[]
}

// Earn represents a earn payment in an earn batch.
export interface Earn {
    destination: PublicKey
    quarks: BigNumber
    invoice?: Invoice
}

// EarnBatchResult contains the results from an earn batch.
export class EarnBatchResult {
    succeeded: EarnResult[];
    failed: EarnResult[];

    constructor() {
        this.succeeded = [];
        this.failed = [];
    }
}

// EarnResult contains the result of a submitted earn.
export interface EarnResult {
    txId?: Buffer
    earn: Earn
    error?: Error
}
