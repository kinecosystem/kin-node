import commonpb from "@kin-beta/agora-api/node/common/v3/model_pb";
import commonpbv4 from "@kin-beta/agora-api/node/common/v4/model_pb";
import { Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Transaction as SolanaTransaction } from "@solana/web3.js";
import { xdr } from "stellar-base";
import { PrivateKey } from "../src";
import {
    AccountDoesNotExist,
    AccountExists,
    AlreadyPaid,
    BadNonce,
    DestinationDoesNotExist,
    errorFromProto,
    errorsFromSolanaTx,
    errorsFromStellarTx,
    errorsFromXdr,
    InsufficientBalance,
    InsufficientFee,
    InvalidSignature,
    invoiceErrorFromProto,
    Malformed,
    SenderDoesNotExist,
    SkuNotFound,
    TransactionFailed,
    WrongDestination
} from "../src/errors";
import { MemoProgram } from "../src/solana/memo-program";

test("parse no errors", () => {
    const resultResult = xdr.TransactionResultResult.txSuccess([
        xdr.OperationResult.opInner(xdr.OperationResultTr.payment(xdr.PaymentResult.paymentSuccess()))
    ]);
    const result = new xdr.TransactionResult({
        feeCharged: new xdr.Int64(0, 0),
        result: resultResult,
        ext: xdr.TransactionResultExt.fromXDR(Buffer.alloc(4)),
    });

    const errors = errorsFromXdr(result);
    expect(errors.TxError).toBeUndefined();
    expect(errors.OpErrors).toBeUndefined();
});

test("unsupported transaction errors", () => {
    const testCases = [
        {
            // "code": "TransactionResultCodeTxTooEarly"
            xdr: "AAAAAAAAAAD////+AAAAAA==",
        },
        {
            // "code": "TransactionResultCodeTxTooLate"
            xdr: "AAAAAAAAAAD////9AAAAAA==",
        },
        {
            // "code": "TransactionResultCodeTxInternalError"
            xdr: "AAAAAAAAAAD////1AAAAAA==",
        },
    ];

    for (const tc of testCases) {
        const result = xdr.TransactionResult.fromXDR(Buffer.from(tc.xdr, "base64"));
        const errorResult = errorsFromXdr(result);
        expect(errorResult.TxError?.message).toContain("unknown transaction result code");
        expect(errorResult.OpErrors).toBeUndefined();
    }
});

test("unsupported operation errors", () => {
    const testCases = [
        {
            // OpCodeNotSupported
            xdr: "AAAAAAAAAAD/////AAAAAf////0AAAAA",
        },
        {
            // Inner -> CreateAccount::LowReserve
            xdr: "AAAAAAAAAAD/////AAAAAQAAAAAAAAAA/////QAAAAA=",
        },
        {
            // Inner -> Payment::LineFull
            xdr: "AAAAAAAAAAD/////AAAAAQAAAAAAAAAB////+AAAAAA=",
        },
        {
            // Inner -> AccountMerge::Malformed
            xdr: "AAAAAAAAAAD/////AAAAAQAAAAAAAAAI/////wAAAAA=",
        },
    ];

    for (const tc of testCases) {
        const result = xdr.TransactionResult.fromXDR(Buffer.from(tc.xdr, "base64"));
        const errorResult = errorsFromXdr(result);
        expect(errorResult.TxError).toBeInstanceOf(TransactionFailed);
        expect(errorResult.OpErrors).toHaveLength(1);
        expect(errorResult.OpErrors![0].message).toContain("unknown");
        expect(errorResult.OpErrors![0].message).toContain("operation");
    }

    // All of the above, but combined
    const xdrBytes = "AAAAAAAAAAD/////AAAABP////0AAAAAAAAAAP////0AAAAAAAAAAf////gAAAAAAAAACP////8AAAAA";
    const result = xdr.TransactionResult.fromXDR(Buffer.from(xdrBytes, "base64"));
    const errorResult = errorsFromXdr(result);
    expect(errorResult.TxError).toBeInstanceOf(TransactionFailed);
    expect(errorResult.OpErrors).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
        expect(errorResult.OpErrors![i].message).toContain("unknown");
        expect(errorResult.OpErrors![i].message).toContain("operation");
    }
});

test("transaction errors", () => {
    const testCases = [
        {
            // "code": "TransactionResultCodeTxMissingOperation"
            expected: Malformed,
            xdr: "AAAAAAAAAAD////8AAAAAA==",
        },
        {
            // "code": "TransactionResultCodeTxBadSeq"
            expected: BadNonce,
            xdr: "AAAAAAAAAAD////7AAAAAA==",
        },
        {
            // "code": "TransactionResultCodeTxBadAuth"
            expected: InvalidSignature,
            xdr: "AAAAAAAAAAD////6AAAAAA==",
        },
        {
            // "code": "TransactionResultCodeTxInsufficientBalance"
            expected: InsufficientBalance,
            xdr: "AAAAAAAAAAD////5AAAAAA==",
        },
        {
            // "code": "TransactionResultCodeTxNoAccount"
            expected: SenderDoesNotExist,
            xdr: "AAAAAAAAAAD////4AAAAAA==",
        },
        {
            // "code": "TransactionResultCodeTxInsufficientFee"
            expected: InsufficientFee,
            xdr: "AAAAAAAAAAD////3AAAAAA==",
        }
    ];

    for (const tc of testCases) {
        const result = xdr.TransactionResult.fromXDR(Buffer.from(tc.xdr, "base64"));
        const errorResult = errorsFromXdr(result);

        expect(errorResult.TxError).toBeInstanceOf(tc.expected);
        expect(errorResult.OpErrors).toBeUndefined();
    }
});

test("operation errors", () => {
    const xdrBytes = "AAAAAAAAAAD/////AAAADf/////////+AAAAAAAAAAD/////AAAAAAAAAAD////+AAAAAAAAAAD////8AAAAAAAAAAH/////AAAAAAAAAAH////+AAAAAAAAAAH////9AAAAAAAAAAH////8AAAAAAAAAAH////7AAAAAAAAAAH////6AAAAAAAAAAH////5AAAAAAAAAAEAAAAAAAAAAA==";
    const result = xdr.TransactionResult.fromXDR(Buffer.from(xdrBytes, "base64"));

    const errorResult = errorsFromXdr(result);
    expect(errorResult.TxError).toBeInstanceOf(TransactionFailed);

    const expected = [
        InvalidSignature,
        SenderDoesNotExist,
        Malformed,
        InsufficientBalance,
        AccountExists,
        Malformed,
        InsufficientBalance,
        Malformed,
        InvalidSignature,
        DestinationDoesNotExist,
        Malformed,
        InvalidSignature,
        // Last operation should not have an error.
    ];

    expect(errorResult.OpErrors).toHaveLength(expected.length + 1);
    for (let i = 0; i < expected.length; i++) {
        expect(errorResult.OpErrors![i]).toBeInstanceOf(expected[i]);
    }

    expect(errorResult.OpErrors![expected.length + 1]).toBeUndefined();
});

test("errorFromProto", () => {
    const testCases = [
        {
            reason: commonpbv4.TransactionError.Reason.NONE,
            expected: undefined,
        },
        {
            reason: commonpbv4.TransactionError.Reason.UNAUTHORIZED,
            expected: InvalidSignature,
        },
        {
            reason: commonpbv4.TransactionError.Reason.BAD_NONCE,
            expected: BadNonce,
        },
        {
            reason: commonpbv4.TransactionError.Reason.INSUFFICIENT_FUNDS,
            expected: InsufficientBalance,
        },
        {
            reason: commonpbv4.TransactionError.Reason.INVALID_ACCOUNT,
            expected: AccountDoesNotExist,
        },
    ];

    testCases.forEach((tc) => {
        const protoError = new commonpbv4.TransactionError();
        protoError.setReason(tc.reason);
        const error = errorFromProto(protoError);
        if (tc.expected) {
            expect(error).toBeInstanceOf(tc.expected);
        } else {
            expect(error).toBeUndefined();
        }
    });
});

test("invoiceErrorFromProto", () => {
    const testCases = [
        {
            reason: commonpb.InvoiceError.Reason.UNKNOWN,
            expected: Error,
        },
        {
            reason: commonpb.InvoiceError.Reason.ALREADY_PAID,
            expected: AlreadyPaid,
        },
        {
            reason: commonpb.InvoiceError.Reason.WRONG_DESTINATION,
            expected: WrongDestination,
        },
        {
            reason: commonpb.InvoiceError.Reason.SKU_NOT_FOUND,
            expected: SkuNotFound,
        },
    ];

    testCases.forEach((tc) => {
        const protoError = new commonpb.InvoiceError();
        protoError.setReason(tc.reason);
        const error = invoiceErrorFromProto(protoError);
        expect(error).toBeInstanceOf(tc.expected);
    });
});

test("errorFromSolanaTx", () => {
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];
    const tx = new SolanaTransaction({
        feePayer: sender.solanaKey(),
    }).add(
        MemoProgram.memo({data: "data"}),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            sender.solanaKey(),
            [],
            100,
        ),
        Token.createSetAuthorityInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            'AccountOwner',
            sender.solanaKey(),
            [],
        ),
    );

    const testCases = [
        {
            index: 1,
            expectedOpIndex: 1,
            expectedPaymentIndex: 0
        },
        {
            index: 0,
            expectedOpIndex: 0,
            expectedPaymentIndex: -1
        },
    ];
    testCases.forEach(tc => {
        const protoError = new commonpbv4.TransactionError();
        protoError.setReason(commonpbv4.TransactionError.Reason.INVALID_ACCOUNT);
        protoError.setInstructionIndex(tc.index);

        const errors = errorsFromSolanaTx(tx, protoError);
        expect(errors.TxError).toBeInstanceOf(AccountDoesNotExist);

        expect(errors.OpErrors).toBeDefined();
        expect(errors.OpErrors!.length).toEqual(3);
        for (let i = 0; i < errors.OpErrors!.length; i++) {
            if (i == tc.expectedOpIndex) {
                expect(errors.OpErrors![i]).toBeInstanceOf(AccountDoesNotExist);
            } else {
                expect(errors.OpErrors![i]).toBeUndefined();
            }
        }

        if (tc.expectedPaymentIndex > -1) {
            expect(errors.PaymentErrors).toBeDefined();
            expect(errors.PaymentErrors!.length).toEqual(1);  // exclude memo instruction + auth instruction
            for (let i = 0; i < errors.PaymentErrors!.length; i++) {
                if (i == tc.expectedPaymentIndex) {
                    expect(errors.PaymentErrors![i]).toBeInstanceOf(AccountDoesNotExist);
                } else {
                    expect(errors.OpErrors![i]).toBeUndefined();
                }
            }
        } else {
            expect(errors.PaymentErrors).toBeUndefined();
        }
    });
});

test("errorFromStellarTx", () => {
    // create, payment, payment, create
    const xdrBytes = "AAAAAMrPQ1diKVqce6E5xOuL76CmGyd/hDnbxB5NdvHkCD+/AAAAAAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAADaGV5AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAQAAAADKz0NXYilanHuhOcTri++gphsnf4Q528QeTXbx5Ag/vwAAAAAAAAAAK+sG64+oMh1NtRMr5w8B8LotsAwIdka6k1dzgATUL4oAAAAAAAAACgAAAAAAAAABAAAAACvrBuuPqDIdTbUTK+cPAfC6LbAMCHZGupNXc4AE1C+KAAAAAAAAAAAAAAAPAAAAAAAAAAEAAAAAK+sG64+oMh1NtRMr5w8B8LotsAwIdka6k1dzgATUL4oAAAAAAAAAAAAAAA8AAAABAAAAAMrPQ1diKVqce6E5xOuL76CmGyd/hDnbxB5NdvHkCD+/AAAAAAAAAAAr6wbrj6gyHU21EyvnDwHwui2wDAh2RrqTV3OABNQvigAAAAAAAAAKAAAAAAAAAAF4eHh4AAAACXNpZ25hdHVyZQAAAA==";
    const env = xdr.TransactionEnvelope.fromXDR(Buffer.from(xdrBytes, "base64"));

    const testCases = [
        {
            index: 2,
            expectedOpIndex: 2,
            expectedPaymentIndex: 1,
        },
        {
            index: 3,
            expectedOpIndex: 3,
            expectedPaymentIndex: -1,
        }
    ];

    testCases.forEach(tc => {
        const protoError = new commonpbv4.TransactionError();
        protoError.setReason(commonpbv4.TransactionError.Reason.INVALID_ACCOUNT);
        protoError.setInstructionIndex(tc.index);

        const errors = errorsFromStellarTx(env, protoError);
        expect(errors.TxError).toBeInstanceOf(AccountDoesNotExist);

        expect(errors.OpErrors).toBeDefined();
        expect(errors.OpErrors!.length).toEqual(4);
        for (let i = 0; i < errors.OpErrors!.length; i++) {
            if (i == tc.expectedOpIndex) {
                expect(errors.OpErrors![i]).toBeInstanceOf(AccountDoesNotExist);
            } else {
                expect(errors.OpErrors![i]).toBeUndefined();
            }
        }

        if (tc.expectedPaymentIndex > -1) {
            expect(errors.PaymentErrors).toBeDefined();
            expect(errors.PaymentErrors!.length).toEqual(2);  // exclude memo instruction
            for (let i = 0; i < errors.PaymentErrors!.length; i++) {
                if (i == tc.expectedPaymentIndex) {
                    expect(errors.PaymentErrors![i]).toBeInstanceOf(AccountDoesNotExist);
                } else {
                    expect(errors.OpErrors![i]).toBeUndefined();
                }
            }
        } else {
            expect(errors.PaymentErrors).toBeUndefined();
        }
    });
});
