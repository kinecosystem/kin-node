import bs58 from "bs58";
import grpc from "grpc";
import hash from "hash.js";
import BigNumber from "bignumber.js";
import { xdr } from "stellar-base";
import { mock, instance, when, anything, verify } from "ts-mockito";
import { PublicKey as SolanaPublicKey, Transaction as SolanaTransaction} from "@solana/web3.js";

import accountpb from "@kinecosystem/agora-api/node/account/v3/account_service_pb";
import accountpbv4 from "@kinecosystem/agora-api/node/account/v4/account_service_pb";
import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import commonpbv4 from "@kinecosystem/agora-api/node/common/v4/model_pb";
import transactionpbv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_pb";

import { InternalClient, SubmitTransactionResult } from "../../src/client";
import { AccountExists, AccountDoesNotExist, TransactionErrors, SkuNotFound, AlreadyPaid, WrongDestination, InvalidSignature, InsufficientBalance, InsufficientFee, TransactionFailed, NoSubsidizerError } from "../../src/errors";
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
    xdrInt64ToBigNumber,
    AccountResolution,
    Commitment,
} from "../../src";
import { TokenInstruction } from "../../src/solana/token-program";
import { MemoInstruction } from "../../src/solana/memo-program";

const recentBlockhash = Buffer.alloc(32);
const subsidizer = PrivateKey.random().publicKey().buffer;
const token = PrivateKey.random().publicKey().buffer;
const tokenProgram = PrivateKey.random().publicKey().buffer;

function setGetServiceConfigResp(client: InternalClient) {
    when(client.getServiceConfig())
        .thenCall(() => {
            const subsidizerAccount = new commonpbv4.SolanaAccountId();
            subsidizerAccount.setValue(subsidizer);
            const tokenAccount = new commonpbv4.SolanaAccountId();
            tokenAccount.setValue(token);
            const tokenProgramAccount = new commonpbv4.SolanaAccountId();
            tokenProgramAccount.setValue(tokenProgram);
            
            const resp = new transactionpbv4.GetServiceConfigResponse();
            resp.setSubsidizerAccount(subsidizerAccount);
            resp.setToken(tokenAccount);
            resp.setTokenProgram(tokenProgramAccount);
            
            return Promise.resolve(resp);
        });
}

function setGetServiceConfigRespNoSubsidizer(client: InternalClient) {
    when(client.getServiceConfig())
        .thenCall(() => {
            const tokenAccount = new commonpbv4.SolanaAccountId();
            tokenAccount.setValue(token);
            const tokenProgramAccount = new commonpbv4.SolanaAccountId();
            tokenProgramAccount.setValue(tokenProgram);
            
            const resp = new transactionpbv4.GetServiceConfigResponse();
            resp.setToken(tokenAccount);
            resp.setTokenProgram(tokenProgramAccount);
            
            return Promise.resolve(resp);
        });
}


function setGetRecentBlockhashResp(client: InternalClient) {
    when(client.getRecentBlockhash())
        .thenCall(() => {
            return Promise.resolve(bs58.encode(recentBlockhash));
        });
}

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
});

test("submitPayment app index not set", async() => {
    const internal = mock(InternalClient);
    const client = new Client(Environment.Test, {internal: instance(internal)});

    when(internal.getAccountInfo(anything()))
        .thenCall(() => {
            return Promise.resolve(new accountpb.AccountInfo());
        });
    when(internal.submitStellarTransaction(anything(), anything()))
        .thenCall(() => {
            return Promise.resolve(new SubmitTransactionResult());
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
    };

    try {
        await client.submitPayment(invoicePayment);
        fail();
    } catch (err) {
        expect(err).toContain("without an app index");
    }
});

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
            return Promise.resolve(new SubmitTransactionResult());
        });

    const sender = PrivateKey.random();
    const channel = PrivateKey.random();
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
            channel: channel,
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

        if (p.channel) {
            expect(request!.envelope.v0().tx().sourceAccountEd25519()).toStrictEqual(channel.kp.rawPublicKey());
            expect(request!.envelope.v0().signatures()).toHaveLength(2);
        } else {
            expect(request!.envelope.v0().tx().sourceAccountEd25519()).toStrictEqual(sender.kp.rawPublicKey());
            expect(request!.envelope.v0().signatures()).toHaveLength(1);
        }

        if (p.memo) {
            expect(p.memo).toBe(request!.envelope.v0().tx().memo().text().toString());
        } else if (p.invoice) {
            const serialized = request!.invoice!.serializeBinary();
            const buf = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex");
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
        const actualAmount = xdrInt64ToBigNumber(request!.envelope.v0().tx().operations()[0].body().paymentOp().amount());
        expect(actualAmount).toStrictEqual(p.quarks);

        if (p.channel) {
            expect(request!.envelope.v0().tx().sourceAccountEd25519()).toStrictEqual(channel.kp.rawPublicKey());
            expect(request!.envelope.v0().signatures()).toHaveLength(3);
        } else {
            expect(request!.envelope.v0().tx().sourceAccountEd25519()).toStrictEqual(sender.kp.rawPublicKey());
            expect(request!.envelope.v0().signatures()).toHaveLength(2);
        }
    }
});

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
            const invoiceError = new commonpb.InvoiceError();
            invoiceError.setOpIndex(0);
            invoiceError.setReason(reason);
            invoiceError.setInvoice(invoiceToProto(payment.invoice!));

            const result: SubmitTransactionResult = {
                TxId: Buffer.alloc(32),
                InvoiceErrors: [
                    invoiceError,
                ],
            };

            reason = (reason % 3) + 1;
            return Promise.resolve(result);
        });

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
    });
    for (let i = 1; i <= 3; i++) {
        try {
            await client.submitPayment(payment);
            fail();
        } catch (err) {
            switch (i) {
                case commonpb.InvoiceError.Reason.ALREADY_PAID:
                    expect(err).toBeInstanceOf(AlreadyPaid);
                    break;
                case commonpb.InvoiceError.Reason.WRONG_DESTINATION:
                    expect(err).toBeInstanceOf(WrongDestination);
                    break;
                case commonpb.InvoiceError.Reason.SKU_NOT_FOUND:
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
                TxId: Buffer.alloc(32),
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
                TxId: Buffer.alloc(32),
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
});

test("submitPayment Kin 2", async() => {
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
            return Promise.resolve(new SubmitTransactionResult());
        });

    const sender = PrivateKey.random();
    const channel = PrivateKey.random();
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
            channel: channel,
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
        kinVersion: 2,
    });
    for (const p of payments) {
        const resp = await client.submitPayment(p);
        expect(request).toBeDefined();
        expect(request!.envelope.v0().tx().seqNum().low).toBe(1);
        expect(request!.envelope.v0().tx().operations()[0].sourceAccount()!.ed25519()).toStrictEqual(sender.kp.rawPublicKey());
        const actualAmount = xdrInt64ToBigNumber(request!.envelope.v0().tx().operations()[0].body().paymentOp().amount());
        // The smallest denomination on Kin 2 is 1e-7, which is smaller by than quarks (1e-5) by 1e2. Therefore, we
        // expect the amount to be equal to p.quarks multiplied by 1e2.
        expect(actualAmount).toStrictEqual(p.quarks.multipliedBy(1e2));

        if (p.channel) {
            expect(request!.envelope.v0().tx().sourceAccountEd25519()).toStrictEqual(channel.kp.rawPublicKey());
            expect(request!.envelope.v0().signatures()).toHaveLength(2);
        } else {
            expect(request!.envelope.v0().tx().sourceAccountEd25519()).toStrictEqual(sender.kp.rawPublicKey());
            expect(request!.envelope.v0().signatures()).toHaveLength(1);
        }

        if (p.memo) {
            expect(p.memo).toBe(request!.envelope.v0().tx().memo().text().toString());
        } else if (p.invoice) {
            const serialized = request!.invoice!.serializeBinary();
            const buf = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex");
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

        if (p.channel) {
            expect(request!.envelope.v0().tx().sourceAccountEd25519()).toStrictEqual(channel.kp.rawPublicKey());
            expect(request!.envelope.v0().signatures()).toHaveLength(3);
        } else {
            expect(request!.envelope.v0().tx().sourceAccountEd25519()).toStrictEqual(sender.kp.rawPublicKey());
            expect(request!.envelope.v0().signatures()).toHaveLength(2);
        }
    }
});

test("submitEarnBatch", async() => {
    const sender = PrivateKey.random();
    const channel = PrivateKey.random();

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
            channel: channel,
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
            return Promise.resolve(new SubmitTransactionResult());
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

            if (b.channel) {
                expect(tx.sourceAccountEd25519()).toStrictEqual(channel.kp.rawPublicKey());
            } else {
                expect(tx.sourceAccountEd25519()).toStrictEqual(sender.kp.rawPublicKey());
            }

            if (b.memo) {
                expect(b.memo).toBe(tx.memo().text().toString());
            } else if (b.earns[0].invoice) {
                const serialized = req.invoice!.serializeBinary();
                const buf = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex");
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
                return Promise.resolve(new SubmitTransactionResult());
            }

            return Promise.resolve({
                TxId: Buffer.alloc(32),
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
    };
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

test("submitEarnBatch Kin 2", async() => {
    const sender = PrivateKey.random();
    const channel = PrivateKey.random();

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
            channel: channel,
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
            return Promise.resolve(new SubmitTransactionResult());
        });

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
        kinVersion: 2,
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

            if (b.channel) {
                expect(tx.sourceAccountEd25519()).toStrictEqual(channel.kp.rawPublicKey());
            } else {
                expect(tx.sourceAccountEd25519()).toStrictEqual(sender.kp.rawPublicKey());
            }

            if (b.memo) {
                expect(b.memo).toBe(tx.memo().text().toString());
            } else if (b.earns[0].invoice) {
                const serialized = req.invoice!.serializeBinary();
                const buf = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex");
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
                // The smallest denomination on Kin 2 is 1e-7, which is smaller by than quarks (1e-5) by 1e2. Therefore,
                // we expect the amount to be multiplied by 1e2.
                expect(op.body().paymentOp().amount().low).toBe((reqId * 100 + opIndex + 1) * 100);
                expect(op.body().paymentOp().destination().ed25519()).toStrictEqual(b.earns[reqId * 100 + opIndex].destination.buffer);
            }
        }
    }
});

// Kin 4 Tests
test("client account management Kin 4", async () => {
    const internal = mock(InternalClient);

    const accountBalances = new Map<string, BigNumber>();
    when(internal.createSolanaAccount(anything(), anything(), anything()))
        .thenCall((account: PrivateKey) => {
            if (accountBalances.has(account.publicKey().toBase58())) {
                throw new AccountExists();
            }

            return Promise.resolve(accountBalances.set(account.publicKey().toBase58(), new BigNumber(10)));
        });
    when(internal.getSolanaAccountInfo(anything(), anything()))
        .thenCall((account: PublicKey) => {
            const balance = accountBalances.get(account.toBase58());
            if (!balance) {
                throw new AccountDoesNotExist();
            }

            const account_info = new accountpbv4.AccountInfo();
            account_info.setBalance(balance.toString());
            return Promise.resolve(account_info);
        });


    const account = PrivateKey.random();
    const client = new Client(Environment.Test, {
        appIndex: 0,
        internal: instance(internal),
        kinVersion: 4,
    });

    await client.createAccount(account);

    try {
        await client.createAccount(account);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(AccountExists);
    }

    expect(await client.getBalance(account.publicKey())).toStrictEqual(new BigNumber(10));
});

test("submitPayment invalid kin version", async() => {
    const internal = mock(InternalClient);
    const client = new Client(Environment.Test, {
        internal: instance(internal),
        kinVersion: 1,
    });

    const sender = PrivateKey.random();
    const dest = PrivateKey.random();
    const payment: Payment = {
        sender: sender,
        destination: dest.publicKey(),
        type: TransactionType.Spend,
        quarks: new BigNumber(11),
    };

    try {
        await client.submitPayment(payment);
        fail();
    } catch (error) {
        expect(error).toContain('kin version');
    }
});
test("submitPayment Kin 4", async() => {
    const internal = mock(InternalClient);

    interface submitRequest {
        tx: SolanaTransaction,
        invoice?: commonpb.InvoiceList,
        commitment?: Commitment,
    }
    let request: submitRequest | undefined;
    const txId = Buffer.from("someid");
    when (internal.submitSolanaTransaction(anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment) => {
            request = {tx, invoice, commitment};
            const result = new SubmitTransactionResult();
            result.TxId = txId;
            return Promise.resolve(result);
        });
    
    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);

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

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
        kinVersion: 4,
    });
    for (const p of payments) {
        const resp = await client.submitPayment(p);
        expect(resp).toEqual(txId);
        
        expect(request).toBeDefined();

        const tx = request!.tx;
        expect(tx.signatures).toHaveLength(2);
        expect(tx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
        expect(tx.signatures[0].signature).toBeNull();
        expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

        expect(tx.instructions).toHaveLength(2);

        const tokenProgramKey = new SolanaPublicKey(tokenProgram);
        const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);
        if (p.memo) {
            expect(memoInstruction.data).toEqual(p.memo);
        } else if (p.invoice) {
            const serialized = request!.invoice!.serializeBinary();
            const buf = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex");
            const expected = Memo.new(1, p.type, 1, buf);

            expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
        } else {
            const expected = Memo.new(1, p.type, 1, Buffer.alloc(29));
            expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
        }
        
        const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[1], tokenProgramKey);
        expect(tokenInstruction.source.toBuffer()).toEqual(p.sender.publicKey().buffer);
        expect(tokenInstruction.dest.toBuffer()).toEqual(p.destination.buffer);
        expect(tokenInstruction.owner.toBuffer()).toEqual(p.sender.publicKey().buffer);
        expect(tokenInstruction.amount).toEqual(BigInt(p.quarks));

    }
});
test("submitPayment Kin 4 with no service subsidizer", async() => {
    const internal = mock(InternalClient);

    interface submitRequest {
        tx: SolanaTransaction,
        invoice?: commonpb.InvoiceList,
        commitment?: Commitment,
    }
    const requests: submitRequest[] = [];
    
    const txId = Buffer.from("someid");
    when(internal.submitSolanaTransaction(anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment) => {
            requests.push({tx, invoice, commitment});
            
            const result = new SubmitTransactionResult();
            result.TxId = txId;
            return Promise.resolve(result);
        });
    
    const sender = PrivateKey.random();
    const dest = PrivateKey.random();
    const appSubsidizer = PrivateKey.random();
    
    setGetServiceConfigRespNoSubsidizer(internal);
    setGetRecentBlockhashResp(internal);

    let p: Payment = {
        sender: sender,
        destination: dest.publicKey(),
        type: TransactionType.Spend,
        quarks: new BigNumber(11),
    };

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
        kinVersion: 4,
    });

    try {
        await client.submitPayment(p);
        fail();
    } catch (error) {
        expect(error).toBeInstanceOf(NoSubsidizerError);
    }

    p = {
        sender: sender,
        destination: dest.publicKey(),
        type: TransactionType.Spend,
        quarks: new BigNumber(11),
        subsidizer: appSubsidizer,
    };
    
    const result = await client.submitPayment(p, );
    expect(result).toEqual(txId);
    expect(requests).toHaveLength(1);

    const request = requests[0];
    expect(request).toBeDefined();

    const tx = request!.tx;
    expect(tx.signatures).toHaveLength(2);
    expect(tx.signatures[0].publicKey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
    expect(appSubsidizer.kp.verify(tx.serializeMessage(), tx.signatures[0].signature!)).toBeTruthy();

    expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

    expect(tx.instructions).toHaveLength(2);
    
    const tokenProgramKey = new SolanaPublicKey(tokenProgram);
    const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);
    
    const expected = Memo.new(1, p.type, 1, Buffer.alloc(29));
    expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
    
    const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[1], tokenProgramKey);
    
    expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(tokenInstruction.dest.toBuffer()).toEqual(dest.publicKey().buffer);
    expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(tokenInstruction.amount).toEqual(BigInt(p.quarks));
});
test("submitPayment Kin 4 with preferred account resolution", async() => {
    const internal = mock(InternalClient);

    interface submitRequest {
        tx: SolanaTransaction,
        invoice?: commonpb.InvoiceList,
        commitment?: Commitment,
    }
    const requests: submitRequest[] = [];
    
    let attemptedSubmission = false;
    const txId = Buffer.from("someid");
    when(internal.submitSolanaTransaction(anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment) => {
            requests.push({tx, invoice, commitment});
            
            const result = new SubmitTransactionResult();
            result.TxId = txId;
            if (!attemptedSubmission) {
                attemptedSubmission = true;
            
                const errors = new TransactionErrors();
                errors.TxError = new AccountDoesNotExist();
                result.Errors = errors;
            }
            return Promise.resolve(result);
        });
    
    const sender = PrivateKey.random();
    const dest = PrivateKey.random();
    const resolvedSender = PrivateKey.random();
    const resolvedDest = PrivateKey.random();
    const resolvedAccounts = new Map<string, PublicKey>([
        [sender.publicKey().toBase58(), resolvedSender.publicKey()],
        [dest.publicKey().toBase58(), resolvedDest.publicKey()],
    ]);
    
    when(internal.resolveTokenAccounts(anything()))
        .thenCall((key: PublicKey) => {
            const resolvedAccount = resolvedAccounts.get(key.toBase58());
            if (resolvedAccount) {
                resolvedAccounts.delete(key.toBase58());
                return Promise.resolve([resolvedAccount]);
            } else {
                return Promise.reject("result should be cached");
            }
        });
    
    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);

    const p: Payment = {
        sender: sender,
        destination: dest.publicKey(),
        type: TransactionType.Spend,
        quarks: new BigNumber(11),
    };

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
        kinVersion: 4,
    });

    let result = await client.submitPayment(p);
    expect(result).toEqual(txId);
    expect(requests).toHaveLength(2);

    const resolved = [false, true];
    requests.forEach((request, i) => {
        expect(request).toBeDefined();

        const tx = request!.tx;
        expect(tx.signatures).toHaveLength(2);
        expect(tx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
        expect(tx.signatures[0].signature).toBeNull();

        expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

        expect(tx.instructions).toHaveLength(2);
        
        const tokenProgramKey = new SolanaPublicKey(tokenProgram);
        const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);
        
        const expected = Memo.new(1, p.type, 1, Buffer.alloc(29));
        expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
        
        const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[1], tokenProgramKey);
        
        if (resolved[i]) {
            expect(tokenInstruction.source.toBuffer()).toEqual(resolvedSender.publicKey().buffer);
            expect(tokenInstruction.dest.toBuffer()).toEqual(resolvedDest.publicKey().buffer);
        } else {
            expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);
            expect(tokenInstruction.dest.toBuffer()).toEqual(dest.publicKey().buffer);
        }
        expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(tokenInstruction.amount).toEqual(BigInt(p.quarks));
    });

    result = await client.submitPayment(p);
    expect(result).toEqual(txId);
    expect(requests).toHaveLength(3);
});
test("submitPayment Kin 4 with exact account resolution", async() => {
    const internal = mock(InternalClient);

    interface submitRequest {
        tx: SolanaTransaction,
        invoice?: commonpb.InvoiceList,
        commitment?: Commitment,
    }
    const requests: submitRequest[] = [];
    
    const txId = Buffer.from("someid");
    when(internal.submitSolanaTransaction(anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment) => {
            requests.push({tx, invoice, commitment});
            
            return Promise.resolve({
                TxId: txId,
                Errors: {
                    TxError: new AccountDoesNotExist(),
                }
            });
        });
    
    const sender = PrivateKey.random();
    const dest = PrivateKey.random();
    
    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);

    const p: Payment = {
        sender: sender,
        destination: dest.publicKey(),
        type: TransactionType.Spend,
        quarks: new BigNumber(11),
    };

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
        kinVersion: 4,
    });

    try {
        await client.submitPayment(p, Commitment.Single, AccountResolution.Exact,  AccountResolution.Exact);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(AccountDoesNotExist);
    }
    
    expect(requests).toHaveLength(1);
    const request = requests[0];
    
    expect(request).toBeDefined();

    const tx = request!.tx;
    expect(tx.signatures).toHaveLength(2);
    expect(tx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
    expect(tx.signatures[0].signature).toBeNull();

    expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

    expect(tx.instructions).toHaveLength(2);
        
    const tokenProgramKey = new SolanaPublicKey(tokenProgram);
    const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);
    
    const expected = Memo.new(1, p.type, 1, Buffer.alloc(29));
    expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
    
    const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[1], tokenProgramKey);    
    expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(tokenInstruction.dest.toBuffer()).toEqual(dest.publicKey().buffer);
    expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(tokenInstruction.amount).toEqual(BigInt(p.quarks));
});
test("submitPayment Kin 4 invalid", async () => {
    const internal = mock(InternalClient);
    const client = new Client(Environment.Test, {
        internal: instance(internal),
        kinVersion: 4,
    });

    const sender = PrivateKey.random();
    const dest = PrivateKey.random();
    const payments: Payment[] = [
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
        {
            sender: sender,
            destination: dest.publicKey(),
            type: TransactionType.Spend,
            quarks: new BigNumber(11),
            channel: PrivateKey.random(),
        },
    ];

    for (const p of payments) {
        try {
            await client.submitPayment(p);
            fail();
        } catch (error) {
            expect(typeof error).toBe('string');
        }
    }
});
test("submitPayment Kin 4 failure", async() => {
    const internal = mock(InternalClient);

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
    when(internal.submitSolanaTransaction(anything(), anything(), anything()))
        .thenCall(() => {
            const invoiceError = new commonpb.InvoiceError();
            invoiceError.setOpIndex(0);
            invoiceError.setReason(reason);
            invoiceError.setInvoice(invoiceToProto(payment.invoice!));

            const result: SubmitTransactionResult = {
                TxId: Buffer.alloc(32),
                InvoiceErrors: [
                    invoiceError,
                ],
            };

            reason = (reason % 3) + 1;
            return Promise.resolve(result);
        });
    
    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
        kinVersion: 4,
    });
    for (let i = 1; i <= 3; i++) {
        try {
            await client.submitPayment(payment);
            fail();
        } catch (err) {
            switch (i) {
                case commonpb.InvoiceError.Reason.ALREADY_PAID:
                    expect(err).toBeInstanceOf(AlreadyPaid);
                    break;
                case commonpb.InvoiceError.Reason.WRONG_DESTINATION:
                    expect(err).toBeInstanceOf(WrongDestination);
                    break;
                case commonpb.InvoiceError.Reason.SKU_NOT_FOUND:
                    expect(err).toBeInstanceOf(SkuNotFound);
                    break;
                default:
                    fail();
            }
        }
    }

    when(internal.submitSolanaTransaction(anything(), anything(), anything()))
        .thenCall(() => {
            return Promise.resolve({
                TxId: Buffer.alloc(32),
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

    when(internal.submitSolanaTransaction(anything(), anything(), anything()))
        .thenCall(() => {
            return Promise.resolve({
                TxId: Buffer.alloc(32),
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
});

test("submitEarnBatch Kin 4", async() => {
    const sender = PrivateKey.random();

    const expectedDestinations: PublicKey[] = [];
    const earns = new Array<Earn>();
    for (let i = 0; i < 60; i++) {
        const dest = PrivateKey.random();
        earns.push({
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
        });
        expectedDestinations.push(dest.publicKey());
    }
    const invoiceEarns = new Array<Earn>();
    for (let i = 0; i < 60; i++) {
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
            earns: earns,
            memo: "somememo",
        },
        {
            sender: sender,
            earns: invoiceEarns,
        },
    ];
    
    interface submitRequest {
        tx: SolanaTransaction,
        invoiceList?: commonpb.InvoiceList,
        commitment?: Commitment,
    }
    let requests: submitRequest[];

    const internal = mock(InternalClient);
    const txId = Buffer.from("someid");
    when (internal.submitSolanaTransaction(anything(), anything(), anything()))
    .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment) => {
            requests.push({tx, invoiceList: invoice, commitment});

            const result = new SubmitTransactionResult();
            result.TxId = txId;

            return Promise.resolve(result);
        });

    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);    

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
        kinVersion: 4,
    });

    for (const b of batches) {
        requests = new Array<submitRequest>();

        const result = await client.submitEarnBatch(b);
        expect(result.succeeded).toHaveLength(60);
        expect(result.failed).toHaveLength(0);

        expect(requests).toHaveLength(4);  // 18-19 earns per batch
        for (let reqId = 0; reqId < requests.length; reqId++) {
            const req = requests[reqId];
            const tx = req.tx;

            expect(tx.signatures).toHaveLength(2);
            expect(tx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
            expect(tx.signatures[0].signature).toBeNull();
            expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
            expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

            const tokenProgramKey = new SolanaPublicKey(tokenProgram);
            const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);
            
            let batchSize: number;
            if (b.memo) {
                expect(memoInstruction.data).toEqual(b.memo);
                batchSize = 19;
            } else if (b.earns[0].invoice) {
                const serialized = req.invoiceList!.serializeBinary();
                const buf = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex");
                const expected = Memo.new(1, TransactionType.Earn, 1, buf);
                
                expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
                batchSize = 18;
            } else {
                // since we have an app index configured, we still expect a memo
                const expected = Memo.new(1, TransactionType.Earn, 1, Buffer.alloc(29));
                expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
                batchSize = 18;
            }
            
            const reqBatchSize = (reqId === 3 ? 60 % batchSize : batchSize);
            expect(tx.instructions).toHaveLength(reqBatchSize + 1);

            for (let i = 0; i < reqBatchSize; i++) {
                const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[i + 1], tokenProgramKey);    
                expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);

                expect(tokenInstruction.dest.toBuffer()).toEqual(b.earns[reqId * batchSize + i].destination.buffer);
                expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
                expect(tokenInstruction.amount).toEqual(BigInt((reqId * batchSize + i + 1)));
            }
        }
    }
});
test("submitEarnBatch Kin 4 with no service subsidizer", async() => {
    const internal = mock(InternalClient);

    const sender = PrivateKey.random();
    const appSubsidizer = PrivateKey.random();
    const earns = new Array<Earn>();
    for (let i = 0; i < 20; i++) {
        const dest = PrivateKey.random();
        earns.push({
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
        });
    }

    interface submitRequest {
        tx: SolanaTransaction,
        invoiceList?: commonpb.InvoiceList,
        commitment?: Commitment,
    }
    const requests: submitRequest[] = [];

    const txId = Buffer.from("someid");
    when(internal.submitSolanaTransaction(anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment) => {
            requests.push({tx, invoiceList: invoice, commitment});

            return Promise.resolve({
                TxId: txId,
            });
        });

    setGetServiceConfigRespNoSubsidizer(internal);
    setGetRecentBlockhashResp(internal);    
    
    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
        kinVersion: 4,
    });

    try {
        await client.submitEarnBatch({
            sender:  sender,
            earns: earns,
        });
        fail();
    } catch (error) {
        expect(error).toBeInstanceOf(NoSubsidizerError);
    }

    const result = await client.submitEarnBatch({
        sender: sender,
        earns: earns,
        subsidizer: appSubsidizer,
    });
    expect(result.succeeded).toHaveLength(20);
    expect(result.failed).toHaveLength(0);
    for (let i = 0; i < 20; i++) {
        expect(result.succeeded[i].earn).toBe(earns[i]);
    }

    expect(requests).toHaveLength(2);
    for (let reqId = 0; reqId < requests.length; reqId++) {
        const req = requests[reqId];
        const tx = req.tx;

        expect(tx.signatures).toHaveLength(2);
        expect(tx.signatures[0].publicKey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
        expect(appSubsidizer.kp.verify(tx.serializeMessage(), tx.signatures[0].signature!)).toBeTruthy();
        expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

        const tokenProgramKey = new SolanaPublicKey(tokenProgram);
        const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);
        
        const expected = Memo.new(1, TransactionType.Earn, 1, Buffer.alloc(29));
        expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
        
        const batchSize = (reqId === requests.length - 1 ? requests.length % 18 : 18);
        expect(tx.instructions).toHaveLength(batchSize + 1);

        for (let i = 0; i < batchSize; i++) {
            const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[i + 1], tokenProgramKey);    
                expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);
                expect(tokenInstruction.dest.toBuffer()).toEqual(earns[reqId * 18 + i].destination.buffer);
                expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
                expect(tokenInstruction.amount).toEqual(BigInt((reqId * 18 + i + 1)));
        }
    }
});
test("submitEarnBatch Kin 4 with preferred account resolution", async() => {
    const internal = mock(InternalClient);

    const sender = PrivateKey.random();
    const resolvedSender = PrivateKey.random();
    const resolvedAccounts = new Map<string, PublicKey>([
        [sender.publicKey().toBase58(), resolvedSender.publicKey()],
    ]);
    
    const originalDests: PublicKey[] = [];
    const resolvedDests: PublicKey[] = [];
    
    const earns = new Array<Earn>();
    for (let i = 0; i < 20; i++) {
        const dest = PrivateKey.random();
        earns.push({
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
        });
        originalDests.push(dest.publicKey());
        
        const resolvedDest = PrivateKey.random().publicKey();
        resolvedDests.push(resolvedDest);
        resolvedAccounts.set(dest.publicKey().toBase58(), resolvedDest);
    }

    interface submitRequest {
        tx: SolanaTransaction,
        invoiceList?: commonpb.InvoiceList,
        commitment?: Commitment,
    }
    const requests: submitRequest[] = [];

    let attemptedSubmission = false;
    const txId = Buffer.from("someid");
    when(internal.submitSolanaTransaction(anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment) => {
            requests.push({tx, invoiceList: invoice, commitment});

            if (!attemptedSubmission) {
                attemptedSubmission = true;
                return Promise.resolve({
                    TxId: txId,
                    Errors: {
                        TxError: new AccountDoesNotExist(),
                    },
                });
            } else {
                attemptedSubmission = false;  // reset for next request
                return Promise.resolve({
                    TxId: txId,
                });
            }
        });

    when(internal.resolveTokenAccounts(anything()))
        .thenCall((key: PublicKey) => {
            const resolvedAccount = resolvedAccounts.get(key.toBase58());
            if (resolvedAccount) {
                resolvedAccounts.delete(key.toBase58());
                return Promise.resolve([resolvedAccount]);
            } else {
                return Promise.reject("result should be cached");
            }
        });

    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);    
    
    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
        kinVersion: 4,
    });

    const result = await client.submitEarnBatch({
        sender: sender,
        earns: earns,
    });
    expect(result.succeeded).toHaveLength(20);
    expect(result.failed).toHaveLength(0);
    for (let i = 0; i < 20; i++) {
        expect(result.succeeded[i].earn).toBe(earns[i]);
    }

    expect(requests).toHaveLength(4);
    for (let reqId = 0; reqId < requests.length; reqId++) {
        const batchIndex = Math.floor(reqId / 2);
        const resolved = (reqId % 2) == 1;
        
        const req = requests[reqId];
        const tx = req.tx;

        expect(tx.signatures).toHaveLength(2);
        expect(tx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
        expect(tx.signatures[0].signature).toBeNull();
        expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

        const tokenProgramKey = new SolanaPublicKey(tokenProgram);
        const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);
        
        const expected = Memo.new(1, TransactionType.Earn, 1, Buffer.alloc(29));
        expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
        
        const reqBatchSize = (batchIndex === 1 ? 20 % 18 : 18);
        expect(tx.instructions).toHaveLength(reqBatchSize + 1);

        for (let i = 0; i < reqBatchSize; i++) {
            const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[i + 1], tokenProgramKey);    
            
            if (resolved) {
                expect(tokenInstruction.source.toBuffer()).toEqual(resolvedSender.publicKey().buffer);
                expect(tokenInstruction.dest.toBuffer()).toEqual(resolvedDests[batchIndex * 18 + i].buffer);
            } else {
                expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);
                expect(tokenInstruction.dest.toBuffer()).toEqual(originalDests[batchIndex * 18 + i].buffer);
            }
            
            expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
            expect(tokenInstruction.amount).toEqual(BigInt((batchIndex * 18 + i + 1)));
        }
    }
});
test("submitEarnBatch Kin 4 with exact account resolution", async() => {
    const internal = mock(InternalClient);

    const sender = PrivateKey.random();
    const earns = new Array<Earn>();
    for (let i = 0; i < 20; i++) {
        const dest = PrivateKey.random();
        earns.push({
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
        });
    }

    interface submitRequest {
        tx: SolanaTransaction,
        invoiceList?: commonpb.InvoiceList,
        commitment?: Commitment,
    }
    const requests: submitRequest[] = [];

    when(internal.submitSolanaTransaction(anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment) => {
            requests.push({tx, invoiceList: invoice, commitment});
            return Promise.resolve({
                TxId: Buffer.alloc(64),
                Errors: {
                    TxError: new AccountDoesNotExist(),
                },
            });
        });

    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);    
    
    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
        kinVersion: 4,
    });

    const result = await client.submitEarnBatch({
        sender: sender,
        earns: earns,
    }, Commitment.Single, AccountResolution.Exact, AccountResolution.Exact);
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(20);
    for (let i = 0; i < 18; i++) {
        expect(result.failed[i].error).toBeInstanceOf(AccountDoesNotExist);
        expect(result.failed[i].earn).toBe(earns[i]);
    }
    for (let i = 18; i < 20; i++) {
        expect(result.failed[i].error).toBeUndefined();
        expect(result.failed[i].earn).toBe(earns[i]);
    }

    expect(requests).toHaveLength(1);
    const req = requests[0];
    const tx = req.tx;

    expect(tx.signatures).toHaveLength(2);
    expect(tx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
    expect(tx.signatures[0].signature).toBeNull();
    expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

    const tokenProgramKey = new SolanaPublicKey(tokenProgram);
    const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);
    
    const expected = Memo.new(1, TransactionType.Earn, 1, Buffer.alloc(29));
    expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
    
    expect(tx.instructions).toHaveLength(18 + 1);

    for (let i = 0; i < 18; i++) {
        const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[i + 1], tokenProgramKey);    
        expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);

        expect(tokenInstruction.dest.toBuffer()).toEqual(earns[i].destination.buffer);
        expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(tokenInstruction.amount).toEqual(BigInt((i + 1)));
    }
});
test("submitEarnBatch Kin 4 failures", async() => {
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
        kinVersion: 4,
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
        kinVersion: 4,
    });
    try {
        await client.submitEarnBatch(badBatch);
        fail();
    } catch (err) {
        expect((<Error>err).message).toContain("all or none");
    }

    // ensure partial failures are handled
    const earns = new Array<Earn>();
    for (let i = 0; i < 60; i++) {
        const dest = PrivateKey.random();
        earns.push({
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
        });
    }

    let failAfter = 1;
    let failWith: TransactionErrors | undefined;
    when(internal.submitSolanaTransaction(anything(), anything(), anything()))
        .thenCall(() => {
            if (failAfter > 0) {
                failAfter--;
                return Promise.resolve(new SubmitTransactionResult());
            }

            return Promise.resolve({
                TxId: Buffer.alloc(32),
                Errors: failWith,
            });
        });

    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);    
    
    client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
        kinVersion: 4,
    });

    failAfter = 1;
    failWith = {
        TxError: new InsufficientFee()
    };
    let result = await client.submitEarnBatch({
        sender: sender,
        earns: earns,
    });
    expect(result.succeeded).toHaveLength(18);
    expect(result.failed).toHaveLength(42);
    for (let i = 0; i < 18; i++) {
        expect(result.failed[i].error).toBeInstanceOf(InsufficientFee);
        expect(result.failed[i].earn).toBe(earns[18+i]);
    }
    for (let i = 18; i < 42; i++) {
        expect(result.failed[i].error).toBeUndefined();
        expect(result.failed[i].earn).toBe(earns[18+i]);
    }

    failAfter = 1;
    failWith = {
        TxError: new TransactionFailed(),
        OpErrors: new Array<Error>(18),
    };
    for (let i = 0; i < 18; i++) {
        if (i%2 == 0) {
            failWith.OpErrors![i] = new InsufficientBalance();
        }
    }
    result = await client.submitEarnBatch({
        sender: sender,
        earns: earns,
    });
    expect(result.succeeded).toHaveLength(18);
    expect(result.failed).toHaveLength(42);

    for (let i = 0; i < result.failed.length; i++) {
        if (i < 18 && i%2 == 0) {
            expect(result.failed[i].error).toBeDefined();
            expect(result.failed[i].error).toBeInstanceOf(InsufficientBalance);
        } else {
            expect(result.failed[i].error).toBeUndefined();
        }
    }
});

// Migration Tests
test("createAccount migration", async () => {
    const internal = mock(InternalClient);

    when(internal.createStellarAccount(anything()))
        .thenCall(() => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.FAILED_PRECONDITION,
            };
            
            throw err;
        });

    when(internal.createSolanaAccount(anything(), anything(), anything()))
        .thenCall(() => {
            return Promise.resolve();
        });

    let version = 3;
    when(internal.setKinVersion(anything()))
        .thenCall((v) => {
            version = v;
        });
        
    
    const account = PrivateKey.random();
    const client = new Client(Environment.Test, {
        appIndex: 0,
        internal: instance(internal),
    });

    await client.createAccount(account);
    
    expect(version).toEqual(4);
    verify(internal.createSolanaAccount(anything(), anything(), anything())).times(1);
});

test("getBalance migration", async () => {
    const internal = mock(InternalClient);

    when(internal.getAccountInfo(anything()))
        .thenCall(() => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.FAILED_PRECONDITION,
            };
            
            throw err;
        });

    when(internal.getSolanaAccountInfo(anything(), anything()))
        .thenCall(() => {
            const accountInfo = new accountpbv4.AccountInfo();
            accountInfo.setBalance("100");
            return Promise.resolve(accountInfo);
        });

    let version = 3;
    when(internal.setKinVersion(anything()))
        .thenCall((v) => {
            version = v;
        });
        
    
    const account = PrivateKey.random();
    const client = new Client(Environment.Test, {
        appIndex: 0,
        internal: instance(internal),
    });

    const balance = await client.getBalance(account.publicKey());
    expect(balance).toEqual(new BigNumber("100"));
    
    expect(version).toEqual(4);
    verify(internal.getSolanaAccountInfo(anything(), anything())).times(1);
});

test("submitPayment migration", async() => {
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
    };

    when(internal.submitStellarTransaction(anything(), anything()))
        .thenCall(() => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.FAILED_PRECONDITION,
            };
            
            throw err;
        });

    interface submitRequest {
        tx: SolanaTransaction,
        invoice?: commonpb.InvoiceList,
        commitment?: Commitment,
    }
    let request: submitRequest | undefined;
    const txId = Buffer.from("someid");
    when (internal.submitSolanaTransaction(anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment) => {
            request = {tx, invoice, commitment};
            const result = new SubmitTransactionResult();
            result.TxId = txId;
            return Promise.resolve(result);
        });
    
        let version = 3;
    when(internal.setKinVersion(anything()))
        .thenCall((v) => {
            version = v;
        });
    
    
    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
    });
    
    const resp = await client.submitPayment(payment);
    expect(resp).toEqual(txId);

    expect(request).toBeDefined();

    const tx = request!.tx;
    expect(tx.signatures).toHaveLength(2);
    expect(tx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
    expect(tx.signatures[0].signature).toBeNull();
    expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

    expect(tx.instructions).toHaveLength(2);

    const tokenProgramKey = new SolanaPublicKey(tokenProgram);
    const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);
    const expected = Memo.new(1, payment.type, 1, Buffer.alloc(29));
    expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
    
    const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[1], tokenProgramKey);
    expect(tokenInstruction.source.toBuffer()).toEqual(payment.sender.publicKey().buffer);
    expect(tokenInstruction.dest.toBuffer()).toEqual(payment.destination.buffer);
    expect(tokenInstruction.owner.toBuffer()).toEqual(payment.sender.publicKey().buffer);
    expect(tokenInstruction.amount).toEqual(BigInt(payment.quarks));

    expect(version).toEqual(4);
    verify(internal.submitSolanaTransaction(anything(), anything(), anything())).times(1);
});
