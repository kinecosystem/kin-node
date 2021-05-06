import { ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Account, Transaction } from "@solana/web3.js";
import base58 from "bs58";
import express from "express";
import hash, { hmac, sha256 } from "hash.js";
import request from "supertest";
import {
    Environment,
    Memo,
    PrivateKey,
    TransactionType
} from "../../src";
import { MemoProgram } from "../../src/solana/memo-program";
import {
    AGORA_HMAC_HEADER,
    AGORA_USER_ID_HEADER,
    AGORA_USER_PASSKEY_HEADER, CreateAccountHandler, CreateAccountRequest, CreateAccountResponse, Event,
    EventsHandler,
    InvoiceError,
    RejectionReason, SignTransactionHandler, SignTransactionRequest,
    SignTransactionResponse
} from "../../src/webhook";


const WEBHOOK_SECRET = "super_secret";
const subsidizer = PrivateKey.random();

const app = express();
app.use("/events", express.json());
app.use("/events", EventsHandler((events: Event[]) => {}, WEBHOOK_SECRET));

app.use("/sign_transaction", express.json());
app.use("/sign_transaction", SignTransactionHandler(Environment.Test, (req: SignTransactionRequest, resp: SignTransactionResponse) => {
}, WEBHOOK_SECRET));

app.use("/create_account", express.json());
app.use("/create_account", CreateAccountHandler(Environment.Test, (req: CreateAccountRequest, resp: CreateAccountResponse) => {
}, WEBHOOK_SECRET));

function getHmacHeader(body: any): string {
    const hex = hmac(<any>sha256, WEBHOOK_SECRET).update(JSON.stringify(body)).digest('hex');
    return Buffer.from(hex, "hex").toString("base64");
}

test("hmac header validation", async () => {
    await request(app)
        .post("/events")
        .set('Accept', 'application/json')
        .send([])
        .expect(401);

    const events: Event[] = [
        {
            transaction_event: {
                tx_id: Buffer.from(base58.decode('2nBhEBYYvfaAe16UMNqRHre4YNSskvuYgx3M6E4JP1oDYvZEJHvoPzyUidNgNX5r9sTyN1J9UxtbCXy2rqYcuyuv')).toString('base64'),
                solana_event: {
                    transaction: 'AVj7dxHlQ9IrvdYVIjuiRFs1jLaDMHixgrv+qtHBwz51L4/ImLZhszwiyEJDIp7xeBSpm/TX5B7mYzxa+fPOMw0BAAMFJMJVqLw+hJYheizSoYlLm53KzgT82cDVmazarqQKG2GQsLgiqktA+a+FDR4/7xnDX7rsusMwryYVUdixfz1B1Qan1RcZLwqvxvJl4/t3zHragsUp0L47E24tAFUgAAAABqfVFxjHdMkoVmOYaR1etoteuKObS21cc1VbIQAAAAAHYUgdNXR0u3xNdiTr072z2DVec9EQQ/wNo1OAAAAAAAtxOUhPBp2WSjUNJEgfvy70BbxI00fZyEPvFHNfxrtEAQQEAQIDADUCAAAAAQAAAAAAAACtAQAAAAAAAAdUE18R96XTJCe+YfRfUp6WP+YKCy/72ucOL8AoBFSpAA==',
                }
            }
        }
    ];

    await request(app)
        .post("/events")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, "blah")
        .send(events)
        .expect(401);

    await request(app)
        .post("/sign_transaction")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, "blah")
        .send(events)
        .expect(401);

    await request(app)
        .post("/events")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(events))
        .send(events)
        .expect(200);

    const sender = PrivateKey.random().publicKey();
    const destination = PrivateKey.random().publicKey();
    const recentBlockhash = PrivateKey.random().publicKey();

    const tx = new Transaction({
        feePayer: subsidizer.publicKey().solanaKey(),
        recentBlockhash: recentBlockhash.toBase58(),
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            sender.solanaKey(),
            [],
            100,
        )
    );

    const signRequest = {
        solana_transaction: tx.serialize({
            verifySignatures: false,
            requireAllSignatures: false,
        }).toString('base64'),
    };

    await request(app)
        .post("/sign_transaction")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(signRequest))
        .send(signRequest)
        .expect(200);

    const mint = PrivateKey.random().publicKey().solanaKey();
    const assoc = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mint,
        sender.solanaKey(),
    );
    const createTx = new Transaction({
        feePayer: subsidizer.publicKey().solanaKey(),
        recentBlockhash: recentBlockhash.toBase58(),
    }).add(
        Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            mint,
            assoc,
            sender.solanaKey(),
            subsidizer.publicKey().solanaKey(),
        ),
        Token.createSetAuthorityInstruction(
            TOKEN_PROGRAM_ID,
            assoc,
            subsidizer.publicKey().solanaKey(),
            'CloseAccount',
            sender.solanaKey(),
            [],
        ),
    );
    
    const createRequest = {
        solana_transaction: createTx.serialize({
            verifySignatures: false,
            requireAllSignatures: false,
        }).toString('base64'),
    };
    
    await request(app)
        .post("/create_account")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(createRequest))
        .send(createRequest)
        .expect(200);
});

test("invalid requests", async () => {
    const garbage = {
        hello: "world"
    };

    await request(app)
        .post("/events")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(garbage))
        .send(garbage)
        .expect(400);

    await request(app)
        .post("/sign_transaction")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(garbage))
        .send(garbage)
        .expect(400);

    const garbageTx = {
        envelope_xdr: "notproperbase64",
    };
    await request(app)
        .post("/sign_transaction")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(garbageTx))
        .send(garbageTx)
        .expect(400);

    await request(app)
        .post("/create_account")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(garbageTx))
        .send(garbageTx)
        .expect(400);

});

test("eventsHandler", async () => {
    const app = express();
    let received = new Array<Event>();

    app.use("/events", express.json());
    app.use("/events", EventsHandler((events: Event[]) => {
        received = events;
    }));

    const sent: Event[] = [
        {
            transaction_event: {
                tx_id: Buffer.from(base58.decode('2nBhEBYYvfaAe16UMNqRHre4YNSskvuYgx3M6E4JP1oDYvZEJHvoPzyUidNgNX5r9sTyN1J9UxtbCXy2rqYcuyuv')).toString('base64'),
                solana_event: {
                    transaction: 'AVj7dxHlQ9IrvdYVIjuiRFs1jLaDMHixgrv+qtHBwz51L4/ImLZhszwiyEJDIp7xeBSpm/TX5B7mYzxa+fPOMw0BAAMFJMJVqLw+hJYheizSoYlLm53KzgT82cDVmazarqQKG2GQsLgiqktA+a+FDR4/7xnDX7rsusMwryYVUdixfz1B1Qan1RcZLwqvxvJl4/t3zHragsUp0L47E24tAFUgAAAABqfVFxjHdMkoVmOYaR1etoteuKObS21cc1VbIQAAAAAHYUgdNXR0u3xNdiTr072z2DVec9EQQ/wNo1OAAAAAAAtxOUhPBp2WSjUNJEgfvy70BbxI00fZyEPvFHNfxrtEAQQEAQIDADUCAAAAAQAAAAAAAACtAQAAAAAAAAdUE18R96XTJCe+YfRfUp6WP+YKCy/72ucOL8AoBFSpAA==',
                    tx_error: 'none',
                    tx_error_raw: 'rawerror',
                }
            }
        },
    ];
    await request(app)
    .post("/events")
    .set('Accept', 'application/json')
    .send(sent)
    .expect(200);
    
    expect(received).toStrictEqual(sent);
});

test("createAccountHandler", async () => {
    const app = express();
    interface createResponse {
        signature: string
    }

    let actualUserId: string | undefined;
    let actualUserPasskey: string | undefined;

    app.use("/create_account", express.json());
    app.use("/create_account", CreateAccountHandler(Environment.Test, (req: CreateAccountRequest, resp: CreateAccountResponse) => {
        actualUserId = req.userId;
        actualUserPasskey = req.userPassKey;

        resp.sign(subsidizer);
    }, WEBHOOK_SECRET));

    const recentBlockhash = PrivateKey.random().publicKey().solanaKey();
    const owner = PrivateKey.random().publicKey().solanaKey();
    const mint = PrivateKey.random().publicKey().solanaKey();
    const assoc = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mint,
        owner,
    );
    const createTx = new Transaction({
        feePayer: subsidizer.publicKey().solanaKey(),
        recentBlockhash: recentBlockhash.toBase58(),
    }).add(
        Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            mint,
            assoc,
            owner,
            subsidizer.publicKey().solanaKey(),
        ),
        Token.createSetAuthorityInstruction(
            TOKEN_PROGRAM_ID,
            assoc,
            subsidizer.publicKey().solanaKey(),
            'CloseAccount',
            owner,
            [],
        ),
    );
    
    const req = {
        solana_transaction: createTx.serialize({
            verifySignatures: false,
            requireAllSignatures: false,
        }).toString('base64'),
    };
    
    const resp = await request(app)
        .post("/create_account")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(req))
        .set(AGORA_USER_ID_HEADER, "user_id")
        .set(AGORA_USER_PASSKEY_HEADER, "user_pass_key")
        .send(req)
        .expect(200);

    expect((<createResponse>resp.body).signature).toBeDefined();
    expect(actualUserId).toBe("user_id");
    expect(actualUserPasskey).toBe("user_pass_key");
});
test("createAccountHandler rejection", async () => {
    const app = express();
    interface createResponse {
        signature: string
    }

    app.use("/create_account", express.json());
    app.use("/create_account", CreateAccountHandler(Environment.Test, (req: CreateAccountRequest, resp: CreateAccountResponse) => {
        resp.reject();
    }, WEBHOOK_SECRET));
    
    const recentBlockhash = PrivateKey.random().publicKey().solanaKey();
    const owner = PrivateKey.random().publicKey().solanaKey();
    const mint = PrivateKey.random().publicKey().solanaKey();
    const assoc = await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mint,
        owner,
    );
    const createTx = new Transaction({
        feePayer: subsidizer.publicKey().solanaKey(),
        recentBlockhash: recentBlockhash.toBase58(),
    }).add(
        Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            mint,
            assoc,
            owner,
            subsidizer.publicKey().solanaKey(),
        ),
        Token.createSetAuthorityInstruction(
            TOKEN_PROGRAM_ID,
            assoc,
            subsidizer.publicKey().solanaKey(),
            'CloseAccount',
            owner,
            [],
        ),
    );
    
    const req = {
        solana_transaction: createTx.serialize({
            verifySignatures: false,
            requireAllSignatures: false,
        }).toString('base64'),
    };
    
    const resp = await request(app)
        .post("/create_account")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(req))
        .send(req)
        .expect(403);

    expect((<createResponse>resp.body).signature).toBeUndefined();
});

test("signtransactionHandler", async () => {
    const app = express();
    interface signResponse {
        signature: string
    }

    let actualUserId: string | undefined;
    let actualUserPasskey: string | undefined;

    app.use("/sign_transaction", express.json());
    app.use("/sign_transaction", SignTransactionHandler(Environment.Test, (req: SignTransactionRequest, resp: SignTransactionResponse) => {
        actualUserId = req.userId;
        actualUserPasskey = req.userPassKey;

        resp.sign(subsidizer);
    }, WEBHOOK_SECRET));

    const sender = PrivateKey.random().publicKey();
    const destination = PrivateKey.random().publicKey();
    const recentBlockhash = PrivateKey.random().publicKey();

    const transaction = new Transaction({
        feePayer: subsidizer.publicKey().solanaKey(),
        recentBlockhash: recentBlockhash.toBase58(),
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            sender.solanaKey(),
            [],
            100,
        )
    );

    const req = {
        solana_transaction: transaction.serialize({
            verifySignatures: false,
            requireAllSignatures: false,
        }).toString("base64"),
        kin_version: 4,
    };

    const resp = await request(app)
        .post("/sign_transaction")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(req))
        .set(AGORA_USER_ID_HEADER, "user_id")
        .set(AGORA_USER_PASSKEY_HEADER, "user_pass_key")
        .send(req)
        .expect(200);

    expect((<signResponse>resp.body).signature).toBeDefined();
    expect(actualUserId).toBe("user_id");
    expect(actualUserPasskey).toBe("user_pass_key");
});

test("signTransactionHandler rejection", async () => {
    const app = express();

    interface signResponse {
        signature: string
        invoice_errors: InvoiceError[]
    }

    app.use("/sign_transaction", express.json());
    app.use("/sign_transaction", SignTransactionHandler(Environment.Test, (req: SignTransactionRequest, resp: SignTransactionResponse) => {
        resp.markSkuNotFound(0);
        resp.markWrongDestination(1);
        resp.markAlreadyPaid(2);
    }));

    const sender = PrivateKey.random().publicKey();
    const destination = PrivateKey.random().publicKey();
    const recentBlockhash = PrivateKey.random().publicKey();
    const b64Invoicelist = "CggKBgoEdGVzdAoKCggKBHRlc3QYAQoKCggKBHRlc3QYAgoKCggKBHRlc3QYAwoKCggKBHRlc3QYBAoKCggKBHRlc3QYBQoKCggKBHRlc3QYBgoKCggKBHRlc3QYBwoKCggKBHRlc3QYCAoKCggKBHRlc3QYCQ==";
    const ilHash = Buffer.from(hash.sha224().update(Buffer.from(b64Invoicelist, 'base64')).digest('hex'), "hex");

    const kinMemo = Memo.new(1, TransactionType.Spend, 1, ilHash);

    const transaction = new Transaction({
        feePayer: subsidizer.publicKey().solanaKey(),
        recentBlockhash: recentBlockhash.toBase58(),
    }).add(MemoProgram.memo({data: kinMemo.buffer.toString("base64")}));

    // There are 10 invoices in the invoice list
    for (let i = 0; i < 10; i++) {
        transaction.add(
            Token.createTransferInstruction(
                TOKEN_PROGRAM_ID,
                sender.solanaKey(),
                destination.solanaKey(),
                sender.solanaKey(),
                [],
                100,
            )
        );
    }

    const req = {
        solana_transaction: transaction.serialize({
            verifySignatures: false,
            requireAllSignatures: false,
        }).toString("base64"),
        kin_version: 4,
        invoice_list: b64Invoicelist,
    };

    const resp = await request(app)
        .post("/sign_transaction")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(req))
        .send(req)
        .expect(403);

    expect((<signResponse>resp.body).signature).toBeUndefined();

    const expectedReasons = [
        RejectionReason.SkuNotFound,
        RejectionReason.WrongDestination,
        RejectionReason.AlreadyPaid,
    ];
    const invoiceErrors = (<signResponse>resp.body).invoice_errors;
    expect(invoiceErrors).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
        expect(invoiceErrors[i].operation_index).toBe(i);
        expect(invoiceErrors[i].reason).toBe(expectedReasons[i]);
    }
});

test("signTransactionRequest getTxId", async () => {
    const owner = PrivateKey.random();
    const sender = PrivateKey.random().publicKey();
    const destination = PrivateKey.random().publicKey();
    const recentBlockhash = PrivateKey.random().publicKey();
    
    const transaction = new Transaction({
        feePayer: subsidizer.publicKey().solanaKey(),
        recentBlockhash: recentBlockhash.toBase58(),
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            owner.publicKey().solanaKey(),
            [],
            100,
        )
    );
    transaction.sign(new Account(owner.secretKey()));
    transaction.sign(new Account(subsidizer.secretKey()));

    const req = new SignTransactionRequest([],[], transaction);
    expect(req.txId()).toEqual(transaction.signature!);
});
