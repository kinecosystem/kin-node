import { xdr } from "stellar-base"
import { 
    errorsFromXdr, 
    Malformed, 
    TransactionFailed, 
    BadNonce, 
    InvalidSignature, 
    InsufficientBalance, 
    SenderDoesNotExist, 
    InsufficientFee, 
    DestinationDoesNotExist, 
    AccountExists 
} from "../src/errors";

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
})

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
})

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
    ]

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
})

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
})

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
    ]

    expect(errorResult.OpErrors).toHaveLength(expected.length + 1);
    for (let i = 0; i < expected.length; i++) {
        expect(errorResult.OpErrors![i]).toBeInstanceOf(expected[i]);
    }

    expect(errorResult.OpErrors![expected.length+1]).toBeUndefined();
})
