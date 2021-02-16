import accountpbv4 from "@kinecosystem/agora-api/node/account/v4/account_service_pb";
import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import commonpbv4 from "@kinecosystem/agora-api/node/common/v4/model_pb";
import transactionpbv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_pb";
import { PublicKey as SolanaPublicKey, Transaction as SolanaTransaction } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import bs58 from "bs58";
import hash from "hash.js";
import { anything, instance, mock, when } from "ts-mockito";
import { v4 as uuidv4 } from 'uuid';
import {
    AccountResolution,
    Client,
    Commitment,
    Earn,
    EarnBatch,
    Environment,
    invoiceToProto,
    Memo,
    Payment,
    PrivateKey,
    PublicKey,
    TransactionData,
    TransactionType
} from "../../src";
import { InternalClient, SubmitTransactionResult } from "../../src/client";
import { AccountDoesNotExist, AccountExists, AlreadyPaid, InsufficientBalance, InsufficientFee, InvalidSignature, NoSubsidizerError, SkuNotFound, TransactionErrors, TransactionFailed, TransactionRejected, WrongDestination } from "../../src/errors";
import { MemoInstruction } from "../../src/solana/memo-program";
import { TokenInstruction } from "../../src/solana/token-program";


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

test("getBalance Kin 4 with account resolution", async () => {
    const internal = mock(InternalClient);

    const account = PrivateKey.random();
    const resolvedAccount = PrivateKey.random();
    const accountBalances = new Map<string, BigNumber>([
        [resolvedAccount.publicKey().toBase58(), new BigNumber(10)],
    ]);


    when(internal.resolveTokenAccounts(anything()))
        .thenCall((key: PublicKey) => {
            if (key.toBase58() == account.publicKey().toBase58()) {
                return Promise.resolve([resolvedAccount.publicKey()]);
            }
        
            return Promise.resolve([]);
        });
    
    
    when(internal.getSolanaAccountInfo(anything(), anything()))
        .thenCall((key: PublicKey) => {
            const balance = accountBalances.get(key.toBase58());
            if (!balance) {
                return Promise.reject(new AccountDoesNotExist());
            }

            const account_info = new accountpbv4.AccountInfo();
            account_info.setBalance(balance.toString());
            return Promise.resolve(account_info);
        });


    const client = new Client(Environment.Test, {
        appIndex: 0,
        internal: instance(internal),
    });

    expect(await client.getBalance(account.publicKey())).toStrictEqual(new BigNumber(10));
});

test("getTransaction Kin 4", async () => {
    const internal = mock(InternalClient);
    when(internal.getTransaction(anything(), anything()))
        .thenCall((txId: Buffer) => {
            const data = new TransactionData();
            data.txId = txId;
            return Promise.resolve(data);
        });
    
    const client = new Client(Environment.Test, {
        appIndex: 0,
        internal: instance(internal),
    });
    
    const txId = Buffer.from("somesig");
    const data = await client.getTransaction(txId);
    expect(data).toBeDefined();
    expect(data!.txId).toEqual(txId);
});

test("submitPayment Kin 4", async() => {
    const internal = mock(InternalClient);

    interface submitRequest {
        tx: SolanaTransaction,
        invoice?: commonpb.InvoiceList,
        commitment?: Commitment,
        dedupeId?: Buffer,
    }
    let request: submitRequest | undefined;
    const txId = Buffer.from("someid");
    when(internal.submitSolanaTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            request = {tx, invoice, commitment, dedupeId};
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
            dedupeId: Buffer.from(uuidv4()),
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
    });
    for (const p of payments) {
        const resp = await client.submitPayment(p);
        expect(resp).toEqual(txId);
        
        expect(request).toBeDefined();
        expect(request!.dedupeId).toEqual(p.dedupeId);

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
        dedupeId?: Buffer,
    }
    const requests: submitRequest[] = [];
    
    const txId = Buffer.from("someid");
    when(internal.submitSolanaTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            requests.push({tx, invoice, commitment, dedupeId});
            
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
        dedupeId?: Buffer,
    }
    const requests: submitRequest[] = [];
    
    let attemptedSubmission = false;
    const txId = Buffer.from("someid");
    when(internal.submitSolanaTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            requests.push({tx, invoice, commitment, dedupeId});
            
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
        dedupeId?: Buffer,
    }
    const requests: submitRequest[] = [];
    
    const txId = Buffer.from("someid");
    when(internal.submitSolanaTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            requests.push({tx, invoice, commitment, dedupeId});
            
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
        }
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
    when(internal.submitSolanaTransaction(anything(), anything(), anything(), anything()))
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

    when(internal.submitSolanaTransaction(anything(), anything(), anything(), anything()))
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

    when(internal.submitSolanaTransaction(anything(), anything(), anything(), anything()))
        .thenCall(() => {
            return Promise.resolve({
                TxId: Buffer.alloc(32),
                Errors: {
                    TxError: new TransactionFailed(),
                    OpErrors: [
                        new InsufficientBalance(),
                    ],
                    PaymentErrors: [
                        new InsufficientBalance(),
                    ],
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
    for (let i = 0; i < 15; i++) {
        const dest = PrivateKey.random();
        earns.push({
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
        });
        expectedDestinations.push(dest.publicKey());
    }
    const invoiceEarns = new Array<Earn>();
    for (let i = 0; i < 15; i++) {
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
            dedupeId: Buffer.from(uuidv4())
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
        dedupeId?: Buffer,
    }
    let request: submitRequest | undefined;

    const internal = mock(InternalClient);
    const txId = Buffer.from("someid");
    when(internal.submitSolanaTransaction(anything(), anything(), anything(), anything()))
    .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            request = {tx, invoiceList: invoice, commitment, dedupeId};

            const result = new SubmitTransactionResult();
            result.TxId = txId;

            return Promise.resolve(result);
        });

    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);    

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
    });

    for (const b of batches) {
        request = undefined;

        const result = await client.submitEarnBatch(b);
        expect(result.txId).toEqual(txId);
        expect(result.txError).toBeUndefined();
        expect(result.earnErrors).toBeUndefined();
        
        expect(request).toBeDefined();
        expect(request!.dedupeId).toEqual(b.dedupeId);
        
        const tx = request!.tx;
        expect(tx.signatures).toHaveLength(2);
        expect(tx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
        expect(tx.signatures[0].signature).toBeNull();
        expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

        const tokenProgramKey = new SolanaPublicKey(tokenProgram);
        const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);
        
        if (b.memo) {
            expect(memoInstruction.data).toEqual(b.memo);
        } else if (b.earns[0].invoice) {
            const serialized = request!.invoiceList!.serializeBinary();
            const buf = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex");
            const expected = Memo.new(1, TransactionType.Earn, 1, buf);
            
            expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
        } else {
            // since we have an app index configured, we still expect a memo
            const expected = Memo.new(1, TransactionType.Earn, 1, Buffer.alloc(29));
            expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
        }
        
        expect(tx.instructions).toHaveLength(16);  // including memo

        for (let i = 0; i < 15; i++) {
            const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[i + 1], tokenProgramKey);    
            expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);

            expect(tokenInstruction.dest.toBuffer()).toEqual(b.earns[i].destination.buffer);
            expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
            expect(tokenInstruction.amount).toEqual(BigInt((i + 1)));
        }
    }
});
test("submitEarnBatch Kin 4 with no service subsidizer", async() => {
    const internal = mock(InternalClient);

    const sender = PrivateKey.random();
    const appSubsidizer = PrivateKey.random();
    const earnCount = 10;
    const earns = new Array<Earn>(earnCount);
    for (let i = 0; i < earnCount; i++) {
        const dest = PrivateKey.random();
        earns[i] = {
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
        };
    }

    interface submitRequest {
        tx: SolanaTransaction,
        invoiceList?: commonpb.InvoiceList,
        commitment?: Commitment,
        dedupeId?: Buffer,
    }
    let request: submitRequest | undefined;

    const txId = Buffer.from("someid");
    when(internal.submitSolanaTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            request = {tx, invoiceList: invoice, commitment, dedupeId};

            return Promise.resolve({
                TxId: txId,
            });
        });

    setGetServiceConfigRespNoSubsidizer(internal);
    setGetRecentBlockhashResp(internal);    
    
    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
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
    expect(result.txId).toEqual(txId);
    expect(result.txError).toBeUndefined();
    expect(result.earnErrors).toBeUndefined();
    
    expect(request).toBeDefined();
    const tx = request!.tx;

    expect(tx.signatures).toHaveLength(2);
    expect(tx.signatures[0].publicKey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
    expect(appSubsidizer.kp.verify(tx.serializeMessage(), tx.signatures[0].signature!)).toBeTruthy();
    expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

    const tokenProgramKey = new SolanaPublicKey(tokenProgram);
    const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);
    
    const expected = Memo.new(1, TransactionType.Earn, 1, Buffer.alloc(29));
    expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
    
    expect(tx.instructions).toHaveLength(earnCount + 1);

    for (let i = 0; i < earnCount; i++) {
        const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[i + 1], tokenProgramKey);    
            expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);
            expect(tokenInstruction.dest.toBuffer()).toEqual(earns[i].destination.buffer);
            expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
            expect(tokenInstruction.amount).toEqual(BigInt((i + 1)));
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
    
    const earnCount = 15;
    const earns = new Array<Earn>(earnCount);
    for (let i = 0; i < earnCount; i++) {
        const dest = PrivateKey.random();
        earns[i] = {
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
        };
        originalDests.push(dest.publicKey());
        
        const resolvedDest = PrivateKey.random().publicKey();
        resolvedDests.push(resolvedDest);
        resolvedAccounts.set(dest.publicKey().toBase58(), resolvedDest);
    }

    interface submitRequest {
        tx: SolanaTransaction,
        invoiceList?: commonpb.InvoiceList,
        commitment?: Commitment,
        dedupeId?: Buffer,
    }
    const requests: submitRequest[] = [];

    let attemptedSubmission = false;
    const txId = Buffer.from("someid");
    when(internal.submitSolanaTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            requests.push({tx, invoiceList: invoice, commitment, dedupeId});

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
    });

    const result = await client.submitEarnBatch({
        sender: sender,
        earns: earns,
    });
    expect(result.txId).toEqual(txId);
    expect(result.txError).toBeUndefined();
    expect(result.earnErrors).toBeUndefined();
    
    expect(requests).toHaveLength(2);
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
        
        expect(tx.instructions).toHaveLength(earnCount + 1);

        for (let i = 0; i < earnCount; i++) {
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

    const earnCount = 15;
    const earns = new Array<Earn>(earnCount);
    for (let i = 0; i < earnCount; i++) {
        const dest = PrivateKey.random();
        earns[i] = {
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
        };
    }

    interface submitRequest {
        tx: SolanaTransaction,
        invoiceList?: commonpb.InvoiceList,
        commitment?: Commitment,
        dedupeId?: Buffer,
    }
    const requests: submitRequest[] = [];

    when(internal.submitSolanaTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: SolanaTransaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            requests.push({tx, invoiceList: invoice, commitment, dedupeId});
            
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
    });

    const result = await client.submitEarnBatch({
        sender: sender,
        earns: earns,
    }, Commitment.Single, AccountResolution.Exact, AccountResolution.Exact);
    expect(result.txId).toEqual(Buffer.alloc(64));
    expect(result.txError).toBeInstanceOf(AccountDoesNotExist);
    expect(result.earnErrors).toBeUndefined();

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
    
    expect(tx.instructions).toHaveLength(earnCount + 1);

    for (let i = 0; i < earnCount; i++) {
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

    // too few earns
    const earns = new Array<Earn>();
    badBatch.earns = earns;
    try {
        await client.submitEarnBatch(badBatch);
        fail();
    } catch (err) {
        expect((<Error>err).message).toContain("at least 1");
    }

    // too many earns
    for (let i = 0; i < 16; i++) {
        const dest = PrivateKey.random();
        earns.push({
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
        });
    }
    try {
        await client.submitEarnBatch(badBatch);
        fail();
    } catch (err) {
        expect((<Error>err).message).toContain("more than 15");
    }

    // reduce to max number of earns of 15
    earns.pop();

    let failWith: TransactionErrors | undefined;
    when(internal.submitSolanaTransaction(anything(), anything(), anything(), anything()))
        .thenCall(() => {
            if (!failWith) {
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
    });

    let result = await client.submitEarnBatch({
        sender: sender,
        earns: earns,
    });
    expect(result.txId).toEqual(Buffer.alloc(32));
    expect(result.txError).toBeUndefined();
    expect(result.earnErrors).toBeUndefined();

    failWith = {
        TxError: new InsufficientFee()
    };
    result = await client.submitEarnBatch({
        sender: sender,
        earns: earns,
    });
    expect(result.txId).toEqual(Buffer.alloc(32));
    expect(result.txError).toBeInstanceOf(InsufficientFee);
    expect(result.earnErrors).toBeUndefined();

    failWith = {
        TxError: new InsufficientBalance(),
        PaymentErrors: new Array<Error>(15),
    };
    for (let i = 0; i < 15; i++) {
        if (i%2 == 0) {
            failWith.PaymentErrors![i] = new InsufficientBalance();
        }
    }
    result = await client.submitEarnBatch({
        sender: sender,
        earns: earns,
    });
    expect(result.txId).toEqual(Buffer.alloc(32));
    expect(result.txError).toBeInstanceOf(InsufficientBalance);
    expect(result.earnErrors).toBeDefined();
    expect(result.earnErrors!).toHaveLength(8);
    for (let i = 0; i < 15; i++) {
        if (i%2 == 0) {
            expect(result.earnErrors![i/2].error).toBeInstanceOf(InsufficientBalance);
            expect(result.earnErrors![i/2].earnIndex).toEqual(i);
        }
    }
});
test("submitEarnBatch Kin 4 invoice errors", async() => {
    const internal = mock(InternalClient);

    // ensure top level bad requests are rejected
    const sender = PrivateKey.random();
    const earnCount = 15;
    const earns = new Array<Earn>(earnCount);
    for (let i = 0; i < earnCount; i++) {
        const dest = PrivateKey.random();
        earns[i] = {
            destination: dest.publicKey(),
            quarks: new BigNumber(1 + i),
        };
    }
    
    let client = new Client(Environment.Test, {
        internal: instance(internal),
    });
    
    when(internal.submitSolanaTransaction(anything(), anything(), anything(), anything()))
        .thenCall(() => {
            const invoiceError = new commonpb.InvoiceError();
            invoiceError.setOpIndex(1);
            invoiceError.setReason(commonpb.InvoiceError.Reason.SKU_NOT_FOUND);
            const invoiceError2 = new commonpb.InvoiceError();
            invoiceError2.setOpIndex(3);
            invoiceError2.setReason(commonpb.InvoiceError.Reason.ALREADY_PAID);
            
            return Promise.resolve({
                TxId: Buffer.alloc(32),
                InvoiceErrors: [
                    invoiceError,
                    invoiceError2
                ]
            });
        });

    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);    
    
    client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
    });

    const result = await client.submitEarnBatch({
        sender: sender,
        earns: earns,
    });
    expect(result.txId).toEqual(Buffer.alloc(32));
    expect(result.txError).toBeInstanceOf(TransactionRejected);
    expect(result.earnErrors).toBeDefined();
    
    expect(result.earnErrors!).toHaveLength(2);
    expect(result.earnErrors![0].earnIndex).toEqual(1);
    expect(result.earnErrors![0].error).toBeInstanceOf(SkuNotFound);
    expect(result.earnErrors![1].earnIndex).toEqual(3);
    expect(result.earnErrors![1].error).toBeInstanceOf(AlreadyPaid);
});

test("requestAirdrop", async() => {
    const internal = mock(InternalClient);

    const pk = PrivateKey.random();
    let client = new Client(Environment.Prod, {
        internal: instance(internal),
    });

    interface airdropReq {
        publicKey: PublicKey,
        quarks: BigNumber,
        commitment?: Commitment,
    }
    let r: airdropReq | undefined;
    when(internal.requestAirdrop(anything(), anything(), anything()))
        .thenCall((publicKey: PublicKey, quarks: BigNumber, commitment: Commitment) => {
            r = {publicKey, quarks, commitment};
            return Promise.resolve(Buffer.alloc(32));
        });

    try {
        await client.requestAirdrop(pk.publicKey(), new BigNumber(10));
        fail();
    } catch (err) {
        expect(err).toContain('test');
        expect(r).toBeUndefined();
    }

    client = new Client(Environment.Test, {
        internal: instance(internal),
        defaultCommitment: Commitment.Recent,
    });
    
    let txID = await client.requestAirdrop(pk.publicKey(), new BigNumber(10));
    expect(txID).toEqual(Buffer.alloc(32));

    expect(r!.publicKey.buffer).toEqual(pk.publicKey().buffer);
    expect(r!.quarks).toEqual(new BigNumber(10));
    expect(r!.commitment).toEqual(Commitment.Recent);

    txID = await client.requestAirdrop(pk.publicKey(), new BigNumber(10), Commitment.Max);
    expect(txID).toEqual(Buffer.alloc(32));

    expect(r!.publicKey.buffer).toEqual(pk.publicKey().buffer);
    expect(r!.quarks).toEqual(new BigNumber(10));
    expect(r!.commitment).toEqual(Commitment.Max);
});
