import { xdr } from "stellar-base";
import commonpbv4 from "@kinecosystem/agora-api/node/common/v4/model_pb";
import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import { Transaction } from "@solana/web3.js";
import { TokenInstruction } from "./solana/token-program";

// TransactionErrors contains the error details for a transaction.
//
export class TransactionErrors {
    // If TxError is defined, the transaction failed.
    TxError?: Error;
    
    // OpErrors may or may not be set if TxErrors is set. If set, the length of
    // OpErrors will match the number of operations/instructions in the transaction.
    OpErrors?: Error[];

    // PaymentErrors may or may not be set if TxErrors is set. If set, the length of 
    // PaymentErrors will match the number of payments/transfers in the transaction.
    PaymentErrors?: Error[];
}

export function errorsFromSolanaTx(tx: Transaction, protoError: commonpbv4.TransactionError): TransactionErrors {
    const errors = new TransactionErrors();
    const err = errorFromProto(protoError);
    if (!err) {
        return errors;
    }
    
    errors.TxError = err;
    if (protoError.getInstructionIndex() >= 0) {
        errors.OpErrors = new Array<Error>(tx.instructions.length);
        errors.OpErrors[protoError.getInstructionIndex()] = err;

        let pIndex = protoError.getInstructionIndex();
        let pCount = 0;

        for (let i = 0; i < tx.instructions.length; i++) {
            try {
                TokenInstruction.decodeTransfer(tx.instructions[i]);
                pCount++;
            } catch (err) {
                if (i < protoError.getInstructionIndex()) {
                    pIndex--;
                } else if (i == protoError.getInstructionIndex()) {
                    // the errored instruction is not a payment
                    pIndex = -1;
                }
            }
        }
        if (pIndex > -1) {
            errors.PaymentErrors = new Array<Error>(pCount);
            errors.PaymentErrors[pIndex] = err;
        }
    }
    
    return errors;
}

export function errorsFromStellarTx(env: xdr.TransactionEnvelope, protoError: commonpbv4.TransactionError): TransactionErrors {
    const errors = new TransactionErrors();
    const err = errorFromProto(protoError);
    if (!err) {
        return errors;
    }
    
    errors.TxError = err;
    if (protoError.getInstructionIndex() >= 0) {
        const ops = env.v0().tx().operations();
        errors.OpErrors = new Array<Error>(ops.length);
        errors.OpErrors[protoError.getInstructionIndex()] = err;

        let pIndex = protoError.getInstructionIndex();
        let pCount = 0;
        for (let i = 0; i < ops.length; i++) {
            if (ops[i].body().switch() === xdr.OperationType.payment()) {
                pCount++;
            } else if (i < protoError.getInstructionIndex()) {
                pIndex--;
            } else if (i == protoError.getInstructionIndex()) {
                pIndex = -1;
            }
        }

        if (pIndex > -1) {
            errors.PaymentErrors = new Array<Error>(pCount);
            errors.PaymentErrors[pIndex] = err;
        }
    }

    return errors;
}

export function errorFromProto(protoError: commonpbv4.TransactionError): Error | undefined {
    switch (protoError.getReason()) {
        case commonpbv4.TransactionError.Reason.NONE:
            return undefined;
        case commonpbv4.TransactionError.Reason.UNAUTHORIZED:
            return new InvalidSignature();
        case  commonpbv4.TransactionError.Reason.BAD_NONCE:
            return new BadNonce();
        case commonpbv4.TransactionError.Reason.INSUFFICIENT_FUNDS:
            return new InsufficientBalance();
        case commonpbv4.TransactionError.Reason.INVALID_ACCOUNT:
            return new AccountDoesNotExist();
        default:
            return Error("unknown error reason: " + protoError.getReason());
    }
}

export function invoiceErrorFromProto(protoError: commonpb.InvoiceError): Error {
    switch (protoError.getReason()) {
        case commonpb.InvoiceError.Reason.ALREADY_PAID:
            return new AlreadyPaid();
        case commonpb.InvoiceError.Reason.WRONG_DESTINATION:
            return new WrongDestination();
        case commonpb.InvoiceError.Reason.SKU_NOT_FOUND:
            return new SkuNotFound();
        default:
            return new Error("unknown invoice error");
    }
}

export function errorsFromXdr(result: xdr.TransactionResult): TransactionErrors {
    const errors = new TransactionErrors();
    switch (result.result().switch()) {
        case xdr.TransactionResultCode.txSuccess():
            return errors;
        case xdr.TransactionResultCode.txMissingOperation():
            errors.TxError = new Malformed();
            break;
        case xdr.TransactionResultCode.txBadSeq():
            errors.TxError = new BadNonce();
            break;
        case xdr.TransactionResultCode.txBadAuth():
            errors.TxError = new InvalidSignature();
            break;
        case xdr.TransactionResultCode.txInsufficientBalance():
            errors.TxError = new InsufficientBalance();
            break;
        case xdr.TransactionResultCode.txInsufficientFee():
            errors.TxError = new InsufficientFee();
            break;
        case xdr.TransactionResultCode.txNoAccount():
            errors.TxError = new SenderDoesNotExist();
            break;
        case xdr.TransactionResultCode.txFailed():
            errors.TxError = new TransactionFailed();
            break;
        default:
            errors.TxError = Error("unknown transaction result code: " + result.result().switch().value);
            break;
    }

    if (result.result().switch() != xdr.TransactionResultCode.txFailed()) {
        return errors;
    }

    errors.OpErrors = new Array<Error>(result.result().results().length);
    result.result().results().forEach((opResult, i) => {
        switch (opResult.switch()) {
            case xdr.OperationResultCode.opInner():
                break;
            case xdr.OperationResultCode.opBadAuth():
                errors.OpErrors![i] = new InvalidSignature();
                return;
            case xdr.OperationResultCode.opNoAccount():
                errors.OpErrors![i] = new SenderDoesNotExist();
                return;
            default:
                errors.OpErrors![i] = new Error("unknown operation result code: " + opResult.switch().value);
                return;
        }

        switch (opResult.tr().switch()) {
            case xdr.OperationType.createAccount():
                switch (opResult.tr().createAccountResult().switch()) {
                    case xdr.CreateAccountResultCode.createAccountSuccess():
                        break;
                    case xdr.CreateAccountResultCode.createAccountMalformed():
                        errors.OpErrors![i] = new Malformed();
                        break;
                    case xdr.CreateAccountResultCode.createAccountAlreadyExist():
                        errors.OpErrors![i] = new AccountExists();
                        break;
                    case xdr.CreateAccountResultCode.createAccountUnderfunded():
                        errors.OpErrors![i] = new InsufficientBalance();
                        break;
                    default:
                        errors.OpErrors![i] = new Error("unknown create operation result code: " + opResult.switch().value);
                }
                break;
            case xdr.OperationType.payment():
                switch (opResult.tr().paymentResult().switch()) {
                    case xdr.PaymentResultCode.paymentSuccess():
                        break;
                    case xdr.PaymentResultCode.paymentMalformed():
                    case xdr.PaymentResultCode.paymentNoTrust():
                    case xdr.PaymentResultCode.paymentSrcNoTrust():
                    case xdr.PaymentResultCode.paymentNoIssuer():
                        errors.OpErrors![i] = new Malformed();
                        break;
                    case xdr.PaymentResultCode.paymentUnderfunded():
                        errors.OpErrors![i] = new InsufficientBalance();
                        break;
                    case xdr.PaymentResultCode.paymentSrcNotAuthorized():
                    case xdr.PaymentResultCode.paymentNotAuthorized():
                        errors.OpErrors![i] = new InvalidSignature();
                        break;
                    case xdr.PaymentResultCode.paymentNoDestination():
                        errors.OpErrors![i] = new DestinationDoesNotExist();
                        break;
                    default:
                        errors.OpErrors![i] = new Error("unknown payment operation result code: " + opResult.switch().value);
                        break;
                }
                break;
            default:
                errors.OpErrors![i] = new Error("unknown operation result at: " + i);
        }
    });

    return errors;
}

export class TransactionFailed extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "TransactionFailed";
        Object.setPrototypeOf(this, TransactionFailed.prototype);
    }
}
export class AccountExists extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "AccountExists";
        Object.setPrototypeOf(this, AccountExists.prototype);
    }
}
export class AccountDoesNotExist extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "AccountDoesNotExist";
        Object.setPrototypeOf(this, AccountDoesNotExist.prototype);
    }
}
export class TransactionNotFound extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "TransactionNotFound";
        Object.setPrototypeOf(this, TransactionNotFound.prototype);
    }
}

export class Malformed extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "Malformed";
        Object.setPrototypeOf(this, Malformed.prototype);
    }
}
export class BadNonce extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "BadNonce";
        Object.setPrototypeOf(this, BadNonce.prototype);
    }
}
export class InsufficientBalance extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "InsufficientBalance";
        Object.setPrototypeOf(this, InsufficientBalance.prototype);
    }
}
export class InsufficientFee extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "InsufficientFee";
        Object.setPrototypeOf(this, InsufficientFee.prototype);
    }
}
export class SenderDoesNotExist extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "SenderDoesNotExist";
        Object.setPrototypeOf(this, SenderDoesNotExist.prototype);
    }
}
export class DestinationDoesNotExist extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "DestinationDoesNotExist";
        Object.setPrototypeOf(this, DestinationDoesNotExist.prototype);
    }
}
export class InvalidSignature extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "InvalidSignature";
        Object.setPrototypeOf(this, InvalidSignature.prototype);
    }
}

export class AlreadyPaid extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "AlreadyPaid";
        Object.setPrototypeOf(this, AlreadyPaid.prototype);
    }
}
export class WrongDestination extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "WrongDestination";
        Object.setPrototypeOf(this, WrongDestination.prototype);
    }
}
export class SkuNotFound extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "SkuNotFound";
        Object.setPrototypeOf(this, SkuNotFound.prototype);
    }
}

export class TransactionRejected extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "TransactionRejected";
        Object.setPrototypeOf(this, TransactionRejected.prototype);
    }
}

export class PayerRequired extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "PayerRequired";
        Object.setPrototypeOf(this, PayerRequired.prototype);
    }
}

export class NoSubsidizerError extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "NoSubsidizerError";
        Object.setPrototypeOf(this, NoSubsidizerError.prototype);
    }
}

export class AlreadySubmitted extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "AlreadySubmittedError";
        Object.setPrototypeOf(this, AlreadySubmitted.prototype);
    }
}

export class NoTokenAccounts extends Error {
    constructor(m?: string) {
        super(m);
        this.name = "NoTokenAccounts";
        Object.setPrototypeOf(this, NoTokenAccounts.prototype);
    }
}

// nonRetriableErrors contains the set of errors that should not be retried without modifications to the transaction.
export const nonRetriableErrors = [
    AccountExists,
    Malformed,
    SenderDoesNotExist,
    DestinationDoesNotExist,
    InsufficientBalance,
    InsufficientFee,
    TransactionRejected,
    AlreadyPaid,
    WrongDestination,
    SkuNotFound,
    BadNonce,
    AlreadySubmitted,
    NoTokenAccounts,
];
