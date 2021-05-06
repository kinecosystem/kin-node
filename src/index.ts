import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import commonpbv4 from "@kinecosystem/agora-api/node/common/v4/model_pb";
import txpbv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_pb";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, u64 } from "@solana/spl-token";
import { SystemInstruction, SystemProgram, Transaction as SolanaTransaction } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import hash from "hash.js";
import { xdr } from "stellar-base";
import { Client } from "./client";
import { errorsFromSolanaTx, errorsFromStellarTx, TransactionErrors } from "./errors";
import { PrivateKey, PublicKey } from "./keys";
import { Memo } from "./memo";
import { MemoInstruction, MemoProgram } from "./solana/memo-program";
import { AccountSize as ACCOUNT_SIZE, Command, getTokenCommand, SetAuthorityParams, TokenInstruction } from "./solana/token-program";

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

export function bigNumberToU64(bn: BigNumber): u64 {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(bn), 0);
    return u64.fromBuffer(b);
}

// Invoice represents a transaction invoice for a single payment.
//
// See https://github.com/kinecosystem/agora-api for details.
export interface Invoice {
    Items: InvoiceItem[]
}

export function protoToInvoice(invoice: commonpb.Invoice): Invoice {
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

    subsidizer?: PrivateKey

    invoice?: Invoice
    memo?: string

    // dedupeId is a unique identifier used by the service to help prevent the 
    // accidental submission of the same intended transaction twice. 
    
    // If dedupeId is set, the service will check to see if a transaction
    // was previously submitted with the same dedupeId. If one is found,
    // it will NOT submit the transaction again, and will return the status 
    // of the previously submitted transaction.
    dedupeId?: Buffer
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

// Creation represents a Kin token account creation.
export interface Creation {
    owner: PublicKey
    address: PublicKey
}

export function parseTransaction(tx: SolanaTransaction, invoiceList?: commonpb.InvoiceList): [Creation[], ReadOnlyPayment[]] {
    const payments: ReadOnlyPayment[] = [];
    const creations: Creation[] = [];

    let invoiceHash: Buffer | undefined;
    if (invoiceList) {
        invoiceHash = Buffer.from(hash.sha224().update(invoiceList.serializeBinary()).digest('hex'), "hex");
    }

    let textMemo: string | undefined;
    let agoraMemo: Memo | undefined;

    let ilRefCount = 0;
    let invoiceTransfers = 0;
    
    let hasEarn = false;
    let hasSpend = false;
    let hasP2P = false;

    let appIndex = 0;
    let appId: string | undefined;
    
    for (let i = 0; i < tx.instructions.length; i++) {
        if (isMemo(tx, i)) {
            const decodedMemo = MemoInstruction.decodeMemo(tx.instructions[i]);
            try {
                agoraMemo = Memo.fromB64String(decodedMemo.data, false);
            } catch (error) {
                textMemo = decodedMemo.data;
            }

            if (textMemo) {
                let parsedId: string | undefined;
                try {
                    parsedId = appIdFromTextMemo(textMemo);
                } catch (error) {
                    continue;
                }

                if (appId && parsedId != appId) {
                    throw new Error("multiple app IDs");
                }

                appId = parsedId;
                continue;
            }

            // From this point on we can assume as have an Agora memo
            const fk = agoraMemo!.ForeignKey();
            if (invoiceHash && fk.slice(0, 28).equals(invoiceHash) && fk[28] === 0) {
                ilRefCount++;
            }

            if (appIndex > 0 && appIndex != agoraMemo!.AppIndex()) {
                throw new Error("multiple app indexes");
            }

            appIndex = agoraMemo!.AppIndex();
            switch (agoraMemo!.TransactionType()) {
                case TransactionType.Earn:
                    hasEarn = true;
                    break;
                case TransactionType.Spend:
                    hasSpend = true;
                    break;
                case TransactionType.P2P:
                    hasP2P = true;
                    break;
                default:
            }
        } else if (isSystem(tx, i)) {
            const create = SystemInstruction.decodeCreateAccount(tx.instructions[i]);
            if  (!create.programId.equals(TOKEN_PROGRAM_ID)) {
                throw new Error("System::CreateAccount must assign owner to the SplToken program");
            }
            if (create.space != ACCOUNT_SIZE) {
                throw new Error("invalid size in System::CreateAccount");
            }

            i++;
            if (i === tx.instructions.length) {
                throw new Error("missing SplToken::InitializeAccount instruction");
            }
            
            const init = TokenInstruction.decodeInitializeAccount(tx.instructions[i]);
            if (!create.newAccountPubkey.equals(init.account)) {
                throw new Error("SplToken::InitializeAccount address does not match System::CreateAccount address");
            }

            i++;
            if (i === tx.instructions.length) {
                throw new Error("missing SplToken::SetAuthority(Close) instruction");
            }

            const closeAuth = TokenInstruction.decodeSetAuthority(tx.instructions[i]);
            if (closeAuth.authorityType !== 'CloseAccount') {
                throw new Error("SplToken::SetAuthority must be of type Close following an initialize");
            }
            if (!closeAuth.account.equals(init.account)) {
                throw new Error("SplToken::SetAuthority(Close) authority must be for the created account");
            }
            if (!closeAuth.newAuthority?.equals(create.fromPubkey)) {
                throw new Error("SplToken::SetAuthority has incorrect new authority");
            }

            // Changing of the account owner is optional
            i++;
            if (i === tx.instructions.length) {
                creations.push({
                    owner: PublicKey.fromSolanaKey(init.owner), 
                    address: PublicKey.fromSolanaKey(init.account),
                });
                break;
            }
            
            let ownerAuth: SetAuthorityParams;
            try {
                 ownerAuth = TokenInstruction.decodeSetAuthority(tx.instructions[i]);
            } catch (error) {
                i--;
                creations.push({
                    owner: PublicKey.fromSolanaKey(init.owner), 
                    address: PublicKey.fromSolanaKey(init.account),
                });
                continue;
            }

            if (ownerAuth.authorityType !== 'AccountOwner') { 
                throw new Error("SplToken::SetAuthority must be of type AccountHolder following a close authority");
            }
            if (!ownerAuth.account.equals(init.account)) {
                throw new Error("SplToken::SetAuthority(AccountHolder) must be for the created account");
            }
            
            creations.push({
                owner: PublicKey.fromSolanaKey(ownerAuth.newAuthority!),
                address: PublicKey.fromSolanaKey(init.account),
            });
        } else if (isSPLAssoc(tx, i)) {
            const create = TokenInstruction.decodeCreateAssociatedAccount(tx.instructions[i]);
            
            i++;
            if (i === tx.instructions.length) {
                throw new Error("missing SplToken::SetAuthority(Close) instruction");
            }

            const closeAuth = TokenInstruction.decodeSetAuthority(tx.instructions[i]);
            if (closeAuth.authorityType !== 'CloseAccount') {
                throw new Error("SplToken::SetAuthority must be of type Close following an assoc creation");
            }
            if (!closeAuth.account.equals(create.address)) {
                throw new Error("SplToken::SetAuthority(Close) authority must be for the created account");
            }
            if (!closeAuth.newAuthority?.equals(create.subsidizer)) {
                throw new Error("SplToken::SetAuthority has incorrect new authority");
            }
            creations.push({
                owner: PublicKey.fromSolanaKey(create.owner),
                address: PublicKey.fromSolanaKey(create.address),
            });
        } else if (isSpl(tx, i)) {
            const cmd = getTokenCommand(tx.instructions[i]);
            if (cmd === Command.Transfer) {
                const transfer = TokenInstruction.decodeTransfer(tx.instructions[i]);
                if (transfer.owner.equals(tx.feePayer!)) {
                    throw new Error("cannot transfer from a subsidizer-owned account");
                }

                let inv: commonpb.Invoice | undefined;
                if (agoraMemo) {
                    const fk = agoraMemo.ForeignKey();
                    if (invoiceHash && fk.slice(0, 28).equals(invoiceHash) && fk[28] === 0) {
                        // If the number of parsed transfers matching this invoice is >= the number of invoices,
                        // raise an error
                        const invoices = invoiceList!.getInvoicesList();
                        if (invoiceTransfers >= invoices.length) {
                            throw new Error(`invoice list doesn't have sufficient invoicesi for this transaction (parsed: ${invoiceTransfers}, invoices: ${invoices.length})`);
                        }
                        inv = invoices[invoiceTransfers];
                        invoiceTransfers++;
                    }
                }

                payments.push({
                    sender: PublicKey.fromSolanaKey(transfer.source),
                    destination: PublicKey.fromSolanaKey(transfer.dest),
                    type: agoraMemo ? agoraMemo.TransactionType() : TransactionType.Unknown,
                    quarks: transfer.amount.toString(),
                    invoice: inv ? protoToInvoice(inv) : undefined,
                    memo: textMemo ? textMemo : undefined,
                });
            } else if (cmd !== Command.CloseAccount) {
                // Closures are valid, but otherwise the instruction is not supported
                throw new Error(`unsupported instruction at ${i}`);
            }
        } else {
            throw new Error(`unsupported instruction at ${i}`);
        }
    }

    if (hasEarn && (hasSpend || hasP2P)) {
        throw new Error("cannot mix earns with P2P/spends");
    }
    if (invoiceList && ilRefCount != 1) {
        throw new Error(`invoice list does not match exactly to one memo in the transaction (matched: ${ilRefCount})`);
    }
    if (invoiceList && invoiceList.getInvoicesList().length != invoiceTransfers) {
        throw new Error(`invoice count (${invoiceList.getInvoicesList().length}) does not match number of transfers referencing the invoice list ${invoiceTransfers}`);
    }

    return [creations, payments];
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
    data.txId = Buffer.from(item.getTransactionId()!.getValue_asU8());
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
        if (item.getTransactionError()) {
            data.errors = errorsFromSolanaTx(solanaTx, item.getTransactionError()!);
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

        if (item.getTransactionError()) {
            data.errors = errorsFromStellarTx(envelope, item.getTransactionError()!);
        }    
    } else {
        // This case *shouldn't* happen since either a solana or stellar should be set
        throw new Error("invalid transaction");
    }

    const payments: ReadOnlyPayment[] = [];
    item.getPaymentsList().forEach((payment, i) => {
        const p: ReadOnlyPayment = {
            sender: new PublicKey(payment.getSource()!.getValue_asU8()),
            destination: new PublicKey(payment.getDestination()!.getValue_asU8()),
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

    return data;
}

// EarnBatch is a batch of earn payments to be sent in a transaction.
export interface EarnBatch {
    sender: PrivateKey
    subsidizer?: PrivateKey

    memo?: string

    // The length of `earns` must be less than or equal to 15.
    earns: Earn[]

    // dedupeId is a unique identifier used by the service to help prevent the 
    // accidental submission of the same intended transaction twice. 
    
    // If dedupeId is set, the service will check to see if a transaction
    // was previously submitted with the same dedupeId. If one is found,
    // it will NOT submit the transaction again, and will return the status 
    // of the previously submitted transaction.
    // 
    // Only available on Kin 4.
    dedupeId?: Buffer
}

// Earn represents a earn payment in an earn batch.
export interface Earn {
    destination: PublicKey
    quarks: BigNumber
    invoice?: Invoice
}

// EarnBatchResult contains the results from an earn batch.
export interface EarnBatchResult {
    txId: Buffer

    // If TxError is defined, the transaction failed.
    txError?: Error

    // earnErrors contains any available earn-specific error
    // information.
    //
    // earnErrors may or may not be set if TxError is set. 
    earnErrors?: EarnError[]
}

export interface EarnError {
    // The error related to an earn.
    error: Error
    // The index of the earn that caused the
    earnIndex: number
}

function isMemo(tx: SolanaTransaction, index: number): boolean {
    return tx.instructions[index].programId.equals(MemoProgram.programId);
}

function isSpl(tx: SolanaTransaction, index: number): boolean {
    return tx.instructions[index].programId.equals(TOKEN_PROGRAM_ID);
}

function isSPLAssoc(tx: SolanaTransaction, index: number): boolean {
    return tx.instructions[index].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID);
}

function isSystem(tx: SolanaTransaction, index: number): boolean {
    return tx.instructions[index].programId.equals(SystemProgram.programId);
}

function appIdFromTextMemo(textMemo: string): string {
    const parts = textMemo.split('-');
    if (parts.length < 2) {
        throw new Error("no app id in memo");
    }

    if (parts[0] != "1") {
        throw new Error("no app id in memo");
    }

    if (!isValidAppId(parts[1])) {
        throw new Error("no valid app id in memo");
    }

    return parts[1];
}

function isValidAppId(appId: string): boolean {
    if (appId.length < 3 || appId.length > 4) {
        return false;
    }
    
    if (!isAlphaNumeric(appId)) {
        return false;
    }

    return true;
}

function isAlphaNumeric(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (!(code > 47 && code < 58) && // numeric (0-9)
        !(code > 64 && code < 91) && // upper alpha (A-Z)
        !(code > 96 && code < 123)) { // lower alpha (a-z)
            return false;
        }
    }
    return true;
}
