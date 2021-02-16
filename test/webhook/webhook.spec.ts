import { Account as SolanaAccount, Transaction as SolanaTransaction } from "@solana/web3.js";
import base58 from "bs58";
import express from "express";
import { hmac, sha256 } from "hash.js";
import request from "supertest";
import {
    Environment,
    PrivateKey
} from "../../src";
import { TokenProgram } from "../../src/solana/token-program";
import {
    AGORA_HMAC_HEADER,
    AGORA_USER_ID_HEADER,
    AGORA_USER_PASSKEY_HEADER, Event,
    EventsHandler,
    InvoiceError,
    RejectionReason, SignTransactionHandler, SignTransactionRequest,
    SignTransactionResponse
} from "../../src/webhook";


const WEBHOOK_SECRET = "super_secret";

const app = express();
app.use("/events", express.json());
app.use("/events", EventsHandler((events: Event[]) => {}, WEBHOOK_SECRET));

app.use("/sign_transaction", express.json());
app.use("/sign_transaction", SignTransactionHandler(Environment.Test, (req: SignTransactionRequest, resp: SignTransactionResponse) => {
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

    const signRequest = {
        solana_transaction: 'AVj7dxHlQ9IrvdYVIjuiRFs1jLaDMHixgrv+qtHBwz51L4/ImLZhszwiyEJDIp7xeBSpm/TX5B7mYzxa+fPOMw0BAAMFJMJVqLw+hJYheizSoYlLm53KzgT82cDVmazarqQKG2GQsLgiqktA+a+FDR4/7xnDX7rsusMwryYVUdixfz1B1Qan1RcZLwqvxvJl4/t3zHragsUp0L47E24tAFUgAAAABqfVFxjHdMkoVmOYaR1etoteuKObS21cc1VbIQAAAAAHYUgdNXR0u3xNdiTr072z2DVec9EQQ/wNo1OAAAAAAAtxOUhPBp2WSjUNJEgfvy70BbxI00fZyEPvFHNfxrtEAQQEAQIDADUCAAAAAQAAAAAAAACtAQAAAAAAAAdUE18R96XTJCe+YfRfUp6WP+YKCy/72ucOL8AoBFSpAA==',
    };

    await request(app)
        .post("/sign_transaction")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(signRequest))
        .send(signRequest)
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

    const garbageEnvelope = {
        envelope_xdr: "notproperbase64",
    };
    await request(app)
        .post("/sign_transaction")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(garbageEnvelope))
        .send(garbageEnvelope)
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

test("signtransactionHandler Kin 4", async () => {
    const app = express();
    interface signResponse {
        envelope_xdr: string
    }

    const sender = PrivateKey.random().publicKey();
    const destination = PrivateKey.random().publicKey();
    const recentBlockhash = PrivateKey.random().publicKey();
    const tokenProgram = PrivateKey.random().publicKey();

    let actualUserId: string | undefined;
    let actualUserPasskey: string | undefined;

    app.use("/sign_transaction", express.json());
    app.use("/sign_transaction", SignTransactionHandler(Environment.Test, (req: SignTransactionRequest, resp: SignTransactionResponse) => {
        actualUserId = req.userId;
        actualUserPasskey = req.userPassKey;
    }, WEBHOOK_SECRET));

    const transaction = new SolanaTransaction({
        feePayer: sender.solanaKey(),
        recentBlockhash: recentBlockhash.toBase58(),
    }).add(
        TokenProgram.transfer({
            source: sender.solanaKey(),
            dest: destination.solanaKey(),
            owner: sender.solanaKey(),
            amount: BigInt(100),
        }, tokenProgram.solanaKey(),
    ));

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

    expect((<signResponse>resp.body).envelope_xdr).toBeUndefined();
    expect(actualUserId).toBe("user_id");
    expect(actualUserPasskey).toBe("user_pass_key");
});

test("signTransactionHandler rejection Kin 4", async () => {
    const app = express();

    interface signResponse {
        envelope_xdr:   string
        invoice_errors: InvoiceError[]
    }

    const sender = PrivateKey.random().publicKey();
    const destination = PrivateKey.random().publicKey();
    const recentBlockhash = PrivateKey.random().publicKey();
    const tokenProgram = PrivateKey.random().publicKey();

    app.use("/sign_transaction", express.json());
    app.use("/sign_transaction", SignTransactionHandler(Environment.Test, (req: SignTransactionRequest, resp: SignTransactionResponse) => {
        resp.markSkuNotFound(0);
        resp.markWrongDestination(1);
        resp.markAlreadyPaid(2);
    }));

    const transaction = new SolanaTransaction({
        feePayer: sender.solanaKey(),
        recentBlockhash: recentBlockhash.toBase58(),
    });
    // There are 10 invoices in the invoice list
    for (let i = 0; i < 10; i++) {
        transaction.add(
            TokenProgram.transfer({
                source: sender.solanaKey(),
                dest: destination.solanaKey(),
                owner: sender.solanaKey(),
                amount: BigInt(100),
            }, tokenProgram.solanaKey(),
        ));
    }

    const req = {
        solana_transaction: transaction.serialize({
            verifySignatures: false,
            requireAllSignatures: false,
        }).toString("base64"),
        kin_version: 4,
        invoice_list: "CggKBgoEdGVzdAoKCggKBHRlc3QYAQoKCggKBHRlc3QYAgoKCggKBHRlc3QYAwoKCggKBHRlc3QYBAoKCggKBHRlc3QYBQoKCggKBHRlc3QYBgoKCggKBHRlc3QYBwoKCggKBHRlc3QYCAoKCggKBHRlc3QYCQ==",
    };

    const resp = await request(app)
        .post("/sign_transaction")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(req))
        .send(req)
        .expect(403);

    expect((<signResponse>resp.body).envelope_xdr).toBeUndefined();

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
    const tokenProgram = PrivateKey.random().publicKey();

    const transaction = new SolanaTransaction({
        feePayer: sender.solanaKey(),
        recentBlockhash: recentBlockhash.toBase58(),
    }).add(
        TokenProgram.transfer({
            source: sender.solanaKey(),
            dest: destination.solanaKey(),
            owner: owner.publicKey().solanaKey(),
            amount: BigInt(100),
        }, tokenProgram.solanaKey(),
    ));
    transaction.sign(new SolanaAccount(owner.secretKey()));

    const req = new SignTransactionRequest([], transaction);
    expect(req.txId()).toEqual(transaction.signature);
});
