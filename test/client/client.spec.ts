import hash from "hash.js";
import BigNumber from "bignumber.js";
import { xdr } from "stellar-base";
import { mock, instance, when, anything } from "ts-mockito";

import transactionpb from "@kinecosystem/agora-api/node/transaction/v3/transaction_service_pb";
import accountpb from "@kinecosystem/agora-api/node/account/v3/account_service_pb";
import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";

import { InternalClient, SubmitStellarTransactionResult } from "../../src/client";
import { AccountExists, AccountDoesNotExist, TransactionErrors, SkuNotFound, AlreadyPaid, WrongDestination, InvalidSignature, InsufficientBalance, InsufficientFee, TransactionFailed } from "../../src/errors";
import {
    Client,
    Memo,
    Earn,
    EarnBatch,
    PrivateKey,
    PublicKey,
    Payment,
    TransactionType,
    invoiceToProto,
    Environment,

 } from "../../src";

test("client account management", async () => {
    const internal = mock(InternalClient);

    const accountBalances = new Map<string, BigNumber>();
    when(internal.createStellarAccount(anything()))
        .thenCall((account: PrivateKey) => {
            if (accountBalances.has(account.publicKey().stellarAddress())) {
                throw new AccountExists();
            }

            return Promise.resolve(accountBalances.set(account.publicKey().stellarAddress(), new BigNumber(10)));
        });
    when(internal.getAccountInfo(anything()))
        .thenCall((account: PublicKey) => {
            const balance = accountBalances.get(account.stellarAddress());
            if (!balance) {
                throw new AccountDoesNotExist();
            }

            const account_info = new accountpb.AccountInfo();
            account_info.setBalance(balance.toString());
            return Promise.resolve(account_info);
        });


    const account = PrivateKey.random();
    const client = new Client(Environment.Test, {
        appIndex: 0,
        internal: instance(internal),
    });

    await client.createAccount(account);

    try {
        await client.createAccount(account);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(AccountExists);
    }

    expect(await client.getBalance(account.publicKey())).toStrictEqual(new BigNumber(10));
})

test("submitPayment app index not set", async() => {
    const internal = mock(InternalClient);
    const client = new Client(Environment.Test, {internal: instance(internal)});

    when(internal.getAccountInfo(anything()))
        .thenCall(() => {
            return Promise.resolve(new accountpb.AccountInfo());
        });
    when(internal.submitStellarTransaction(anything(), anything()))
        .thenCall(() => {
            return Promise.resolve(new SubmitStellarTransactionResult());
        });

    const sender = PrivateKey.random();
    const dest = PrivateKey.random();
    const payments: Payment[] = [
        {
            sender: sender,
            destination: dest.publicKey(),
            type: TransactionType.Spend,
            quarks: new BigNumber(11),
        },
        {
            sender: sender,
            destination: dest.publicKey(),
            type: TransactionType.Spend,
            quarks: new BigNumber(11),
            memo: "1-test"
        },
    ];

    for (const p of payments) {
        await client.submitPayment(p);
    }

    const invoicePayment: Payment = {
        sender: sender,
        destination: dest.publicKey(),
        type: TransactionType.Spend,
        quarks: new BigNumber(11),
        invoice:  {
            Items: [
                {
                    title: "test",
                    amount: new BigNumber(11),
                },
            ],
        },
    }

    try {
        await client.submitPayment(invoicePayment);
        fail();
    } catch (err) {
        expect(err).toContain("without an app index")
    }
})

test("submitPayment", async() => {
    const internal = mock(InternalClient);

    when(internal.getAccountInfo(anything()))
        .thenCall((_: PublicKey) => {
            return Promise.resolve(new accountpb.AccountInfo());
        });

    interface submitRequest {
        envelope: xdr.TransactionEnvelope,
        invoice?: commonpb.InvoiceList,
    }
    let request: submitRequest | undefined;
    when (internal.submitStellarTransaction(anything(), anything()))
        .thenCall((envelope: xdr.TransactionEnvelope, invoice?: commonpb.InvoiceList) => {
            request = {envelope, invoice};
            return Promise.resolve(new SubmitStellarTransactionResult());
        });

    const sender = PrivateKey.random();
    const source = PrivateKey.random();
    const dest = PrivateKey.random();

    const payments: Payment[] = [
        {
            sender: sender,
            destination: dest.publicKey(),
            type: TransactionType.Spend,
            quarks: new BigNumber(11),
        },
        {
            sender: sender,
            source: source,
            destination: dest.publicKey(),
            type: TransactionType.Spend,
            quarks: new BigNumber(11),
        },
        {
            sender: sender,
            destination: dest.publicKey(),
            type: TransactionType.Spend,
            quarks: new BigNumber(11),
            memo: "1-test",
        },
        {
            sender: sender,
            destination: dest.publicKey(),
            type: TransactionType.Spend,
            quarks: new BigNumber(11),
            invoice: {
                Items: [
                    {
                        title: "test",
                        amount: new BigNumber(10),
                    }
                ]
            },
        },
    ];

    let client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
    });
    for (const p of payments) {
        const resp = await client.submitPayment(p);
        expect(request).toBeDefined();
        expect(request!.envelope.v0().tx().seqNum().low).toBe(1);
        expect(request!.envelope.v0().tx().operations()[0].sourceAccount()!.ed25519()).toStrictEqual(sender.kp.rawPublicKey());

        if (p.source) {
            expect(request!.envelope.v0().tx().sourceAccountEd25519()).toStrictEqual(source.kp.rawPublicKey());
            expect(request!.envelope.v0().signatures()).toHaveLength(2);
        } else {
            expect(request!.envelope.v0().tx().sourceAccountEd25519()).toStrictEqual(sender.kp.rawPublicKey());
            expect(request!.envelope.v0().signatures()).toHaveLength(1);
        }

        if (p.memo) {
            expect(p.memo).toBe(request!.envelope.v0().tx().memo().text().toString())
        } else if (p.invoice) {
            const serialized = request!.invoice!.serializeBinary();
            const buf = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex")
            const expected = Memo.new(1, p.type, 1, buf);

            const actual = Memo.fromXdr(request!.envelope.v0().tx().memo(), true);
            expect(actual?.buffer).toStrictEqual(expected.buffer);
        } else {
            expect(request!.envelope.v0().tx().memo().switch()).toBe(xdr.MemoType.memoHash());

            const expected = Memo.new(1, p.type, 1, Buffer.alloc(29));
            const actual = Memo.fromXdr(request!.envelope.v0().tx().memo(), true);
            expect(actual?.buffer).toStrictEqual(expected.buffer);
        }
    }

    client = new Client(Environment.Test, {
        appIndex: 1,
        whitelistKey: PrivateKey.random(),
        internal: instance(internal),
    });
    for (const p of payments) {
        const resp = await client.submitPayment(p);
        expect(request).toBeDefined();
        expect(request!.envelope.v0().tx().seqNum().low).toBe(1);
        expect(request!.envelope.v0().tx().operations()[0].sourceAccount()!.ed25519()).toStrictEqual(sender.kp.rawPublicKey());

        if (p.source) {
            expect(request!.envelope.v0().tx().sourceAccountEd25519()).toStrictEqual(source.kp.rawPublicKey());
            expect(request!.envelope.v0().signatures()).toHaveLength(3);
        } else {
            expect(request!.envelope.v0().tx().sourceAccountEd25519()).toStrictEqual(sender.kp.rawPublicKey());
            expect(request!.envelope.v0().signatures()).toHaveLength(2);
        }
    }
})

test("submitPayment failure", async() => {
    const internal = mock(InternalClient);

    when(internal.getAccountInfo(anything()))
        .thenCall(() => {
            return Promise.resolve(new accountpb.AccountInfo());
        });

    const sender = PrivateKey.random();
    const dest = PrivateKey.random();
    const payment: Payment = {
        sender: sender,
        destination: dest.publicKey(),
        type: TransactionType.Spend,
        quarks: new BigNumber(11),
        invoice: {
            Items: [
                {
                    title: "test",
                    amount: new BigNumber(11),
                }
            ]
        }
    };

    let reason = 1;
    when(internal.submitStellarTransaction(anything(), anything()))
        .thenCall(() => {
            const invoiceError = new transactionpb.SubmitTransactionResponse.InvoiceError();
            invoiceError.setOpIndex(0);
            invoiceError.setReason(reason);
            invoiceError.setInvoice(invoiceToProto(payment.invoice!));

            const result: SubmitStellarTransactionResult = {
                TxHash: Buffer.alloc(32),
                InvoiceErrors: [
                    invoiceError,
                ],
            }

            reason = (reason % 3) + 1
            return Promise.resolve(result);
        });

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
    })
    for (let i = 1; i <= 3; i++) {
        try {
            await client.submitPayment(payment);
            fail();
        } catch (err) {
            switch (i) {
                case transactionpb.SubmitTransactionResponse.InvoiceError.Reason.ALREADY_PAID:
                    expect(err).toBeInstanceOf(AlreadyPaid);
                    break;
                case transactionpb.SubmitTransactionResponse.InvoiceError.Reason.WRONG_DESTINATION:
                    expect(err).toBeInstanceOf(WrongDestination);
                    break;
                case transactionpb.SubmitTransactionResponse.InvoiceError.Reason.SKU_NOT_FOUND:
                    expect(err).toBeInstanceOf(SkuNotFound);
                    break;
                default:
                    fail();
            }
        }
    }

    when(internal.submitStellarTransaction(anything(), anything()))
        .thenCall(() => {
            return Promise.resolve({
                TxHash: Buffer.alloc(32),
                Errors: {
                    TxError: new InvalidSignature(),
                }
            });
        });

    try{
        await client.submitPayment(payment);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(InvalidSignature);
    }

    when(internal.submitStellarTransaction(anything(), anything()))
        .thenCall(() => {
            return Promise.resolve({
                TxHash: Buffer.alloc(32),
                Errors: {
                    TxError: new TransactionFailed(),
                    OpErrors: [
                        new InsufficientBalance(),
                    ]
                }
            });
        });

    try{
        await client.submitPayment(payment);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(InsufficientBalance);
    }
})

test("submitEarnBatch", async() => {
    const sender = PrivateKey.random();
    const source = PrivateKey.random();

    const earns = new Array<Earn>();
    for (let i = 0; i < 202; i++) {
        const dest = PrivateKey.random();
        earns.push({
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
        });
    }
    const invoiceEarns = new Array<Earn>();
    for (let i = 0; i < 202; i++) {
        const dest = PrivateKey.random();
        invoiceEarns.push({
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
            invoice: {
                Items: [
                    {
                        title: "test",
                        amount: new BigNumber(i + 1),
                    }
                ]
            },
        });
    }

    const batches: EarnBatch[] = [
        {
            sender: sender,
            earns: earns,
        },
        {
            sender: sender,
            source: source,
            earns: earns,
        },
        {
            sender: sender,
            earns: invoiceEarns,
        },
    ];

    interface submitRequest {
        envelope: xdr.TransactionEnvelope,
        invoice?: commonpb.InvoiceList,
    }
    let requests = new Array<submitRequest>();

    let seq = 0;
    const internal = mock(InternalClient);
    when (internal.getAccountInfo(anything()))
        .thenCall(() => {
            const accountInfo = new accountpb.AccountInfo();
            accountInfo.setSequenceNumber(seq.toString());
            seq++;

            return Promise.resolve(accountInfo);
        });
    when (internal.submitStellarTransaction(anything(), anything()))
        .thenCall((envelope: xdr.TransactionEnvelope, invoice?: commonpb.InvoiceList) => {
            requests.push({envelope, invoice});
            return Promise.resolve(new SubmitStellarTransactionResult());
        });

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
    });

    for (const b of batches) {
        requests = new Array<submitRequest>();
        seq = 0;

        const result = await client.submitEarnBatch(b);
        expect(requests).toHaveLength(3);

        for (let reqId = 0; reqId < requests.length; reqId++) {
            const req = requests[reqId];
            const tx = req.envelope.v0().tx();

            expect(tx.operations()).toHaveLength(Math.min(100, b.earns.length - reqId*100));
            expect(tx.seqNum().low).toBe(reqId+1);

            if (b.source) {
                expect(tx.sourceAccountEd25519()).toStrictEqual(source.kp.rawPublicKey());
            } else {
                expect(tx.sourceAccountEd25519()).toStrictEqual(sender.kp.rawPublicKey());
            }

            if (b.memo) {
                expect(b.memo).toBe(tx.memo().text().toString())
            } else if (b.earns[0].invoice) {
                const serialized = req.invoice!.serializeBinary();
                const buf = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex")
                const expected = Memo.new(1, TransactionType.Earn, 1, buf);
                expect(tx.memo().hash()).toStrictEqual(expected.buffer);
            } else {
                // since we have an app index configured, we still expect a memo
                const expected = Memo.new(1, TransactionType.Earn, 1, Buffer.alloc(29));
                expect(tx.memo().switch()).toBe(xdr.MemoType.memoHash());
                expect(tx.memo().hash()).toStrictEqual(expected.buffer);
            }

            for (let opIndex = 0; opIndex < tx.operations().length; opIndex++) {
                const op = tx.operations()[opIndex];
                expect(op.sourceAccount()!.ed25519()).toStrictEqual(sender.kp.rawPublicKey());
                expect(op.body().paymentOp().amount().low).toBe((reqId * 100 + opIndex + 1));
                expect(op.body().paymentOp().destination().ed25519()).toStrictEqual(b.earns[reqId * 100 + opIndex].destination.buffer);
            }
        }
    }
});

test("submitEarnBatch failures", async() => {
    const internal = mock(InternalClient);

    // ensure top level bad requests are rejected
    const sender = PrivateKey.random();
    const badBatch: EarnBatch = {
        sender: sender,
        earns: [
            {
                destination: PrivateKey.random().publicKey(),
                quarks: new BigNumber(10),
                invoice: {
                    Items: [
                        {
                            title: "test",
                            amount: new BigNumber(10),
                        }
                    ]
                }
            },
        ],
    };

    let client = new Client(Environment.Test, {
        internal: instance(internal),
    });
    try {
        await client.submitEarnBatch(badBatch);
        fail();
    } catch (err) {
        expect((<Error>err).message).toContain("without an app index");
    }

    badBatch.earns.push({
        destination: PrivateKey.random().publicKey(),
        quarks: new BigNumber(10),
    });

    client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
    });
    try {
        await client.submitEarnBatch(badBatch);
        fail();
    } catch (err) {
        expect((<Error>err).message).toContain("all or none");
    }

    // ensure partial failures are handled
    const earns = new Array<Earn>();
    for (let i = 0; i < 202; i++) {
        const dest = PrivateKey.random();
        earns.push({
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
        });
    }

    let failAfter = 1;
    let failWith: TransactionErrors | undefined;
    when(internal.getAccountInfo(anything())).thenCall(() => {
        return Promise.resolve(new accountpb.AccountInfo());
    });
    when(internal.submitStellarTransaction(anything(), anything()))
        .thenCall(() => {
            if (failAfter > 0) {
                failAfter--;
                return Promise.resolve(new SubmitStellarTransactionResult());
            }

            return Promise.resolve({
                TxHash: Buffer.alloc(32),
                Errors: failWith,
            });
        });
    client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
    });

    failAfter = 1;
    failWith = {
        TxError: new InsufficientFee()
    };
    let result = await client.submitEarnBatch({
        sender: sender,
        earns: earns,
    });
    expect(result.succeeded).toHaveLength(100);
    expect(result.failed).toHaveLength(102);
    for (let i = 0; i < 100; i++) {
        expect(result.failed[i].error).toBeInstanceOf(InsufficientFee);
        expect(result.failed[i].earn).toBe(earns[100+i]);
    }
    for (let i = 100; i < 102; i++) {
        expect(result.failed[i].error).toBeUndefined();
        expect(result.failed[i].earn).toBe(earns[100+i]);
    }

    failAfter = 1;
    failWith = {
        TxError: new TransactionFailed(),
        OpErrors: new Array<Error>(100),
    }
    for (let i = 0; i < 100; i++) {
        if (i%2 == 0) {
            failWith.OpErrors![i] = new InsufficientBalance();
        }
    }
    result = await client.submitEarnBatch({
        sender: sender,
        earns: earns,
    });
    expect(result.succeeded).toHaveLength(100);
    expect(result.failed).toHaveLength(102);

    for (let i = 0; i < result.failed.length; i++) {
        if (i < 100 && i%2 == 0) {
            expect(result.failed[i].error).toBeDefined();
            expect(result.failed[i].error).toBeInstanceOf(InsufficientBalance);
        } else {
            expect(result.failed[i].error).toBeUndefined();
        }
    }
});
