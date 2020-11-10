import express from "express";
import request from "supertest";
import { hmac, sha256 } from "hash.js";
import { Keypair, xdr, TransactionBuilder } from "stellar-base";
import { Account as SolanaAccount, Transaction as SolanaTransaction, } from "@solana/web3.js";

import {
    Event,
    EventsHandler,
    SignTransactionRequest,
    SignTransactionResponse,
    SignTransactionHandler,
    AGORA_HMAC_HEADER,
    AGORA_USER_ID_HEADER,
    AGORA_USER_PASSKEY_HEADER,
    InvoiceError,
    RejectionReason,
} from "../../src/webhook";
import {
    Environment,
    NetworkPasshrase,
    PrivateKey,
 } from "../../src";
import { TokenProgram } from "../../src/solana/token-program";
import base58 from "bs58";

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
                kin_version: 3,
                tx_hash: "",

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
        // stolen from a Go test
        envelope_xdr: "AAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAADAp4yjwgs7DQ5hMiUyMqzpC22u6NWTXaX85D4qbzTj9wAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAALpctlQBhbHSdXACe6mk64mbrrl6DjRI5U7eAy2I3TUTAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAAlbaWfZsuwTJg+gyJYp8vcDTwNWazt4rt+0K8TMkW374AAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAAA6KpnKS3rx9Vyqcj1oVWUHHXo9Tnf9t0ComjOg7C26AwAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAAGhVkpXOey36N862ZAPRVa2MAUJt93b4DRjarjSn9mZUAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAA6BljUXmxqUtHbyBqIF09xdgf115SP4FbwFg+49en2IoAAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAABqBXeFh+UFtWbGv2hJ2jLYEQsfTY3aeE16LkP0S1P0MgAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAACFDsaY8xZjoFL3U9TZYdOdcAHOYD78JI/a9dY95sGNUAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAAS8TkraTWvQD38UQZcDqEWKX7UPlUlQGwsZfKQ9O2KPIAAAAAAAAAAAAAAAoAAAAAAAAAAA==",
    };

    await request(app)
        .post("/sign_transaction")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(signRequest))
        .send(signRequest)
        .expect(403); // we didn't sign it, so 403 instead of 200
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
                kin_version: 3,
                tx_hash: Buffer.from('1eb4acda0b10c275f2fb14f891772a957634f1205b908be10ba2ed68bdcc68f3', 'hex').toString('base64'),
            }
        },
        {
            transaction_event: {
                kin_version: 3,
                tx_hash: Buffer.from('81f382dd636281ebe295fd49fe7b729f7da7ab0e6c561ec116d438d67c332999', 'hex').toString('base64'),
                stellar_event: {
                    envelope_xdr: 'AAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAADAp4yjwgs7DQ5hMiUyMqzpC22u6NWTXaX85D4qbzTj9wAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAALpctlQBhbHSdXACe6mk64mbrrl6DjRI5U7eAy2I3TUTAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAAlbaWfZsuwTJg+gyJYp8vcDTwNWazt4rt+0K8TMkW374AAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAAA6KpnKS3rx9Vyqcj1oVWUHHXo9Tnf9t0ComjOg7C26AwAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAAGhVkpXOey36N862ZAPRVa2MAUJt93b4DRjarjSn9mZUAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAA6BljUXmxqUtHbyBqIF09xdgf115SP4FbwFg+49en2IoAAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAABqBXeFh+UFtWbGv2hJ2jLYEQsfTY3aeE16LkP0S1P0MgAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAACFDsaY8xZjoFL3U9TZYdOdcAHOYD78JI/a9dY95sGNUAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAAS8TkraTWvQD38UQZcDqEWKX7UPlUlQGwsZfKQ9O2KPIAAAAAAAAAAAAAAAoAAAAAAAAAAA==',
                    result_xdr: 'AAAAAAAAAAAAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAA=',
                }
            }
        },
        {
            transaction_event: {
                kin_version: 4,
                tx_id: Buffer.from(base58.decode('2nBhEBYYvfaAe16UMNqRHre4YNSskvuYgx3M6E4JP1oDYvZEJHvoPzyUidNgNX5r9sTyN1J9UxtbCXy2rqYcuyuv')).toString('base64'),
            }
        },
        {
            transaction_event: {
                kin_version: 4,
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

    expect(received[0].transaction_event.tx_id).toEqual(received[0].transaction_event.tx_hash);
    expect(received[1].transaction_event.tx_id).toEqual(received[1].transaction_event.tx_hash);
    delete received[0].transaction_event.tx_id;
    delete received[1].transaction_event.tx_id;

    expect(received).toStrictEqual(sent);
});

test("signtransactionHandler", async () => {
    const app = express();
    const serverKeypair = PrivateKey.random();
    const localKeypair = PrivateKey.random();

    interface signResponse {
        envelope_xdr: string
    }

    let actualUserId: string | undefined;
    let actualUserPasskey: string | undefined;

    app.use("/sign_transaction", express.json());
    app.use("/sign_transaction", SignTransactionHandler(Environment.Test, (req: SignTransactionRequest, resp: SignTransactionResponse) => {
        actualUserId = req.userId;
        actualUserPasskey = req.userPassKey;

        resp.sign(serverKeypair);
    }, WEBHOOK_SECRET));

    let envelope = xdr.TransactionEnvelope.fromXDR("AAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAADAp4yjwgs7DQ5hMiUyMqzpC22u6NWTXaX85D4qbzTj9wAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAALpctlQBhbHSdXACe6mk64mbrrl6DjRI5U7eAy2I3TUTAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAAlbaWfZsuwTJg+gyJYp8vcDTwNWazt4rt+0K8TMkW374AAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAAA6KpnKS3rx9Vyqcj1oVWUHHXo9Tnf9t0ComjOg7C26AwAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAAGhVkpXOey36N862ZAPRVa2MAUJt93b4DRjarjSn9mZUAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAA6BljUXmxqUtHbyBqIF09xdgf115SP4FbwFg+49en2IoAAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAABqBXeFh+UFtWbGv2hJ2jLYEQsfTY3aeE16LkP0S1P0MgAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAACFDsaY8xZjoFL3U9TZYdOdcAHOYD78JI/a9dY95sGNUAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAAS8TkraTWvQD38UQZcDqEWKX7UPlUlQGwsZfKQ9O2KPIAAAAAAAAAAAAAAAoAAAAAAAAAAA==", "base64") ;
    const builder = TransactionBuilder.fromXDR(envelope, NetworkPasshrase.Test);
    builder.sign(localKeypair.kp);
    envelope = builder.toEnvelope();

    const req = {
        envelope_xdr: envelope.toXDR("base64"),
    };
    let resp = await request(app)
        .post("/sign_transaction")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(req))
        .send(req)
        .expect(200);

    let returnedEnvelope = xdr.TransactionEnvelope.fromXDR((<signResponse>resp.body).envelope_xdr, "base64");
    expect(returnedEnvelope.v0().signatures()).toHaveLength(2);
    expect(actualUserId).toBeUndefined();
    expect(actualUserPasskey).toBeUndefined();

    resp = await request(app)
        .post("/sign_transaction")
        .set('Accept', 'application/json')
        .set(AGORA_HMAC_HEADER, getHmacHeader(req))
        .set(AGORA_USER_ID_HEADER, "user_id")
        .set(AGORA_USER_PASSKEY_HEADER, "user_pass_key")
        .send(req)
        .expect(200);

    returnedEnvelope = xdr.TransactionEnvelope.fromXDR((<signResponse>resp.body).envelope_xdr, "base64");
    expect(returnedEnvelope.v0().signatures()).toHaveLength(2);
    expect(actualUserId).toBe("user_id");
    expect(actualUserPasskey).toBe("user_pass_key");
});

test("signTransactionHandler rejection", async () => {
    const app = express();
    const localKeypair = PrivateKey.random();

    interface signResponse {
        envelope_xdr:   string
        invoice_errors: InvoiceError[]
    }

    app.use("/sign_transaction", express.json());
    app.use("/sign_transaction", SignTransactionHandler(Environment.Test, (req: SignTransactionRequest, resp: SignTransactionResponse) => {
        resp.markSkuNotFound(0);
        resp.markWrongDestination(1);
        resp.markAlreadyPaid(2);
    }));

    let envelope = xdr.TransactionEnvelope.fromXDR("AAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAADAp4yjwgs7DQ5hMiUyMqzpC22u6NWTXaX85D4qbzTj9wAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAALpctlQBhbHSdXACe6mk64mbrrl6DjRI5U7eAy2I3TUTAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAAlbaWfZsuwTJg+gyJYp8vcDTwNWazt4rt+0K8TMkW374AAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAAA6KpnKS3rx9Vyqcj1oVWUHHXo9Tnf9t0ComjOg7C26AwAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAAGhVkpXOey36N862ZAPRVa2MAUJt93b4DRjarjSn9mZUAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAA6BljUXmxqUtHbyBqIF09xdgf115SP4FbwFg+49en2IoAAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAABqBXeFh+UFtWbGv2hJ2jLYEQsfTY3aeE16LkP0S1P0MgAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAACFDsaY8xZjoFL3U9TZYdOdcAHOYD78JI/a9dY95sGNUAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAAS8TkraTWvQD38UQZcDqEWKX7UPlUlQGwsZfKQ9O2KPIAAAAAAAAAAAAAAAoAAAAAAAAAAA==", "base64") ;
    const builder = TransactionBuilder.fromXDR(envelope, NetworkPasshrase.Test);
    builder.sign(localKeypair.kp);
    envelope = builder.toEnvelope();

    const req = {
        envelope_xdr: envelope.toXDR("base64"),
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

test("signtransactionHandler Kin 4", async () => {
    const app = express();
    const serverKeypair = PrivateKey.random();

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

    let req = new SignTransactionRequest([], 4, undefined, undefined, transaction);
    expect(req.txId()).toEqual(transaction.signature);

    const keypair = PrivateKey.random();
    let envelope = xdr.TransactionEnvelope.fromXDR("AAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAADAp4yjwgs7DQ5hMiUyMqzpC22u6NWTXaX85D4qbzTj9wAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAALpctlQBhbHSdXACe6mk64mbrrl6DjRI5U7eAy2I3TUTAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAAlbaWfZsuwTJg+gyJYp8vcDTwNWazt4rt+0K8TMkW374AAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAAA6KpnKS3rx9Vyqcj1oVWUHHXo9Tnf9t0ComjOg7C26AwAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAAGhVkpXOey36N862ZAPRVa2MAUJt93b4DRjarjSn9mZUAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAA6BljUXmxqUtHbyBqIF09xdgf115SP4FbwFg+49en2IoAAAAAAAAAAAAAAAoAAAABAAAAAEUO4l6xxAcS8984GVe3Kq02DSZzOwojZCJsVqLtGbiyAAAAAQAAAABqBXeFh+UFtWbGv2hJ2jLYEQsfTY3aeE16LkP0S1P0MgAAAAAAAAAAAAAACgAAAAEAAAAARQ7iXrHEBxLz3zgZV7cqrTYNJnM7CiNkImxWou0ZuLIAAAABAAAAACFDsaY8xZjoFL3U9TZYdOdcAHOYD78JI/a9dY95sGNUAAAAAAAAAAAAAAAKAAAAAQAAAABFDuJescQHEvPfOBlXtyqtNg0mczsKI2QibFai7Rm4sgAAAAEAAAAAS8TkraTWvQD38UQZcDqEWKX7UPlUlQGwsZfKQ9O2KPIAAAAAAAAAAAAAAAoAAAAAAAAAAA==", "base64") ;
    const builder = TransactionBuilder.fromXDR(envelope, NetworkPasshrase.Test);
    builder.sign(keypair.kp);
    envelope = builder.toEnvelope();

    req = new SignTransactionRequest([], 3, NetworkPasshrase.Test, envelope);
    expect(req.txId()).toEqual(builder.hash());
});
