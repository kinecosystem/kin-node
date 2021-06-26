import accountpbv4 from "@kinecosystem/agora-api/node/account/v4/account_service_pb";
import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import commonpbv4 from "@kinecosystem/agora-api/node/common/v4/model_pb";
import transactionpbv4, { GetMinimumBalanceForRentExemptionResponse } from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_pb";
import { ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Account, PublicKey as SolanaPublicKey, SystemInstruction, Transaction } from "@solana/web3.js";
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
import { SignTransactionResult } from "../../src/client/internal";
import { AccountDoesNotExist, AccountExists, AlreadyPaid, InsufficientBalance, InsufficientFee, InvalidSignature, NoSubsidizerError, SkuNotFound, TransactionErrors, TransactionFailed, TransactionRejected, WrongDestination } from "../../src/errors";
import { MemoInstruction } from "../../src/solana/memo-program";
import { AccountSize, TokenInstruction } from "../../src/solana/token-program";

const recentBlockhash = Buffer.alloc(32);
const subsidizerKey = PrivateKey.random();
const subsidizer = subsidizerKey.publicKey().buffer;
const token = PrivateKey.random().publicKey().buffer;
const tokenProgram = PrivateKey.random().publicKey().buffer;
const minBalance = 2039280

interface signRequest {
    tx: Transaction,
    il?: commonpb.InvoiceList
}

interface submitRequest {
    tx: Transaction,
    il?: commonpb.InvoiceList,
    commitment?: Commitment,
    dedupeId?: Buffer,
}

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

function setGetMinBalanceForRentExemptionResp(client: InternalClient) {
    when(client.getMinimumBalanceForRentExemption())
        .thenCall(() => {
            return Promise.resolve(minBalance);
        });
}

test("client account management", async () => {
    const internal = mock(InternalClient);

    const accountBalances = new Map<string, BigNumber>();
    when(internal.createAccount(anything(), anything(), anything()))
        .thenCall((account: PrivateKey) => {
            if (accountBalances.has(account.publicKey().toBase58())) {
                throw new AccountExists();
            }

            return Promise.resolve(accountBalances.set(account.publicKey().toBase58(), new BigNumber(10)));
        });
    when(internal.getAccountInfo(anything(), anything()))
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

test("getBalance with account resolution", async () => {
    const internal = mock(InternalClient);

    const account = PrivateKey.random();
    const balances = ["10", "15"];

    when(internal.getAccountInfo(anything(), anything()))
        .thenCall(() => {
            return Promise.reject(new AccountDoesNotExist());
        });

    when(internal.resolveTokenAccounts(anything(), anything()))
        .thenCall((key: PublicKey) => {
            if (key.toBase58() == account.publicKey().toBase58()) {
                const infos: accountpbv4.AccountInfo[] = [];
                balances.forEach(balance => {
                    const id = new commonpbv4.SolanaAccountId();
                    id.setValue(PrivateKey.random().publicKey().buffer);
                    const info = new accountpbv4.AccountInfo();
                    info.setAccountId(id);
                    info.setBalance(balance);
                    infos.push(info);
                });

                return Promise.resolve(infos);
            }

            return Promise.resolve([]);
        });

    const client = new Client(Environment.Test, {
        appIndex: 0,
        internal: instance(internal),
    });

    expect(await client.getBalance(account.publicKey())).toStrictEqual(new BigNumber(10));
});

test("resolveTokenAccounts", async () => {
    const internal = mock(InternalClient);

    const account = PrivateKey.random();
    const tokenAccounts = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    when(internal.getAccountInfo(anything(), anything()))
        .thenCall(() => {
            return Promise.reject(new AccountDoesNotExist());
        });

    when(internal.resolveTokenAccounts(anything(), anything()))
        .thenCall((key: PublicKey) => {
            if (key.toBase58() == account.publicKey().toBase58()) {
                const infos: accountpbv4.AccountInfo[] = [];

                tokenAccounts.forEach(tokenAccount => {
                    const id = new commonpbv4.SolanaAccountId();
                    id.setValue(tokenAccount.buffer);
                    const info = new accountpbv4.AccountInfo();
                    info.setAccountId(id);
                    infos.push(info);
                });

                return Promise.resolve(infos);
            }

            return Promise.resolve([]);
        });

    const client = new Client(Environment.Test, {
        appIndex: 0,
        internal: instance(internal),
    });

    const resolved = await client.resolveTokenAccounts(account.publicKey());
    expect(resolved.length).toEqual(tokenAccounts.length);
    resolved.forEach((pk, i) => {
        expect(pk.buffer).toEqual(tokenAccounts[i].buffer);
    });
});

test("mergeTokenAccounts", async() => {
    const internal = mock(InternalClient);
    const client = new Client(Environment.Test, {
        appIndex: 0,
        internal: instance(internal),
    });

    const appSubsidizer = PrivateKey.random();
    const priv = PrivateKey.random();

    const ownerId = new commonpbv4.SolanaAccountId();
    ownerId.setValue(priv.publicKey().buffer);

    const closeAuthId = new commonpbv4.SolanaAccountId();

    // No accounts to merge
    when(internal.resolveTokenAccounts(anything(), anything()))
    .thenCall(() => {
        return Promise.resolve([]);
    });

    let txId = await client.mergeTokenAccounts(priv, false);
    expect(txId).toBeUndefined();

    // One resolved account, no create assoc
    let resolvedKeys = [PrivateKey.random().publicKey()];
    let infos: accountpbv4.AccountInfo[] = [];

    setGetServiceConfigResp(internal);
    when(internal.resolveTokenAccounts(anything(), anything()))
    .thenCall(() => {
        infos = [];
        resolvedKeys.forEach((key, i) => {
            const id = new commonpbv4.SolanaAccountId();
            id.setValue(key.buffer);
            const info = new accountpbv4.AccountInfo();
            info.setAccountId(id);
            info.setBalance(new BigNumber(1 + i).toString());
            info.setOwner(ownerId);
            info.setCloseAuthority(closeAuthId);

            infos.push(info);
        });
        return Promise.resolve(infos);
    });

    txId = await client.mergeTokenAccounts(priv, false);
    expect(txId).toBeUndefined();

    // Multiple accounts
    resolvedKeys = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    let signReq: signRequest | undefined;
    let submitReq: submitRequest | undefined;
    setGetRecentBlockhashResp(internal);
    when(internal.signTransaction(anything(), anything()))
        .thenCall((tx: Transaction, il?: commonpb.InvoiceList) => {
            // Make a copy of the transaction since we're modifying it
            signReq = {tx: Transaction.from(tx.serialize({
                requireAllSignatures: false,
                verifySignatures: false,
            })), il};

            const result = new SignTransactionResult();
            if (tx.feePayer!.toBuffer().equals(subsidizer)){
                tx.partialSign(new Account(subsidizerKey.secretKey()));
            }
            result.TxId = tx.signature ? tx.signature : undefined;
            return Promise.resolve(result);
        });
    when(internal.submitTransaction!(anything(), anything(), anything(), anything()))
        .thenCall((tx: Transaction, il?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            submitReq = {tx, il: il, commitment, dedupeId};
            const result = new SubmitTransactionResult();
            result.TxId = tx.signature!;
            return Promise.resolve(result);
        });

    interface testCase {
        createAssoc: boolean;
        subsidizer?: PrivateKey;
        shouldClose: boolean;
    }

    const tcs: testCase[] = [
        {
            createAssoc: false,
            shouldClose: false,
        },
        {
            createAssoc: true,
            shouldClose: false,
        },
        {
            createAssoc: false,
            subsidizer: appSubsidizer,
            shouldClose: false,
        },
        {
            createAssoc: true,
            subsidizer: appSubsidizer,
            shouldClose: false,
        },
        {
            createAssoc: false,
            shouldClose: true,

        },
    ];

    for (const tc of tcs) {
        signReq = undefined;
        submitReq = undefined;

        if (tc.shouldClose) {
            if (tc.subsidizer) {
                closeAuthId.setValue(tc.subsidizer.publicKey().buffer);
            } else {
                closeAuthId.setValue(subsidizer);
            }
        } else {
            closeAuthId.setValue('');
        }

        txId = await client.mergeTokenAccounts(priv, tc.createAssoc, Commitment.Single, tc.subsidizer);
        expect(txId).toBeDefined();

        if (tc.subsidizer) {
            expect(signReq).toBeUndefined();
            expect(submitReq).toBeDefined();

            const submitTx = submitReq!.tx;
            expect(submitTx.signatures).toHaveLength(2);
            expect(submitTx.signatures[0].publicKey.toBuffer()).toEqual(tc.subsidizer.publicKey().buffer);
            expect(tc.subsidizer.kp.verify(submitTx.serializeMessage(), submitTx.signatures[0].signature!)).toBeTruthy();
            expect(submitTx.signatures[1].publicKey.toBuffer()).toEqual(priv.publicKey().buffer);
            expect(priv.kp.verify(submitTx.serializeMessage(), submitTx.signatures[1].signature!)).toBeTruthy();
            await assertMergeTx(submitTx, priv, infos, tc.createAssoc, tc.shouldClose, Buffer.from(closeAuthId.getValue_asU8()), tc.subsidizer);

            // The returned txId should be the one in the submit request
            expect(txId!.equals(submitTx.signature!)).toBeTruthy();
        } else {
            expect(signReq).toBeDefined();
            const signTx = signReq!.tx;
            expect(signTx.signatures).toHaveLength(2);
            expect(signTx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
            expect(signTx.signatures[0].signature).toBeNull();
            expect(signTx.signatures[1].publicKey.toBuffer()).toEqual(priv.publicKey().buffer);
            expect(priv.kp.verify(signTx.serializeMessage(), signTx.signatures[1].signature!)).toBeTruthy();
            await assertMergeTx(signTx, priv, infos, tc.createAssoc, tc.shouldClose, Buffer.from(closeAuthId.getValue_asU8()));

            expect(submitReq).toBeDefined();

            const submitTx = submitReq!.tx;
            expect(submitTx.signatures).toHaveLength(2);
            expect(submitTx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
            expect(subsidizerKey.kp.verify(submitTx.serializeMessage(), submitTx.signatures[0].signature!)).toBeTruthy();
            expect(submitTx.signatures[1].publicKey.toBuffer()).toEqual(priv.publicKey().buffer);
            expect(priv.kp.verify(submitTx.serializeMessage(), submitTx.signatures[1].signature!)).toBeTruthy();

            expect(submitTx.serializeMessage().equals(signTx.serializeMessage())).toBeTruthy();

            // The returned txId should be the one in the submit request
            expect(txId!.equals(submitTx.signature!)).toBeTruthy();
        }
    }
});

async function assertMergeTx(tx: Transaction, priv: PrivateKey, infos: accountpbv4.AccountInfo[], createAssoc: boolean, shouldClose: boolean, closeAuth?: Buffer, appSubsidizer?: PrivateKey) {
    let dest: SolanaPublicKey;
    let remainingAccounts: accountpbv4.AccountInfo[] = [];
    let i = 0;
    if (createAssoc) {
        const assoc = await Token.getAssociatedTokenAddress(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            new SolanaPublicKey(token),
            priv.publicKey().solanaKey(),
        );

        // create, set auth, and [transfer, optional[close]] for each account
        if (shouldClose) {
            expect(tx.instructions.length).toEqual(2 * (infos.length + 1));
        } else {
            expect(tx.instructions.length).toEqual(2 + infos.length);
        }

        const createAssoc = TokenInstruction.decodeCreateAssociatedAccount(tx.instructions[i]);
        expect(createAssoc.subsidizer.toBuffer()).toEqual(appSubsidizer ? appSubsidizer.publicKey().buffer : subsidizer);
        expect(createAssoc.address.toBuffer()).toEqual(assoc.toBuffer());
        expect(createAssoc.owner.toBuffer()).toEqual(priv.publicKey().buffer);
        expect(createAssoc.mint.toBuffer()).toEqual(token);

        i++;
        const setAuth = TokenInstruction.decodeSetAuthority(tx.instructions[i]);
        expect(setAuth.account.toBuffer()).toEqual(assoc.toBuffer());
        expect(setAuth.currentAuthority.toBuffer()).toEqual(priv.publicKey().buffer);
        expect(setAuth.authorityType).toEqual('CloseAccount');
        expect(setAuth.newAuthority!.toBuffer()).toEqual(appSubsidizer ? appSubsidizer.publicKey().buffer : subsidizer);

        i++;
        dest = assoc;
        remainingAccounts = infos;
    } else {
        // [transfer, optional[close]] for all but one account
        if (shouldClose) {
            expect(tx.instructions.length).toEqual(2 * (infos.length - 1));
        } else {
            expect(tx.instructions.length).toEqual(infos.length - 1);
        }

        dest = new SolanaPublicKey(infos[0].getAccountId()!.getValue_asU8());
        remainingAccounts = infos.slice(1);
    }

    remainingAccounts.forEach(info => {
        const transfer = TokenInstruction.decodeTransfer(tx.instructions[i]);
        expect(transfer.source.toBuffer()).toEqual(Buffer.from(info.getAccountId()!.getValue_asU8()));
        expect(transfer.dest).toEqual(dest);
        expect(transfer.owner.toBuffer()).toEqual(priv.publicKey().buffer);
        expect(transfer.amount).toEqual(BigInt(new BigNumber(info.getBalance()).toNumber()));

        i++;

        if (shouldClose) {
            const close = TokenInstruction.decodeCloseAccount(tx.instructions[i]);
            expect(close.account.toBuffer()).toEqual(Buffer.from(info.getAccountId()!.getValue_asU8()));
            expect(close.destination.toBuffer()).toEqual(appSubsidizer ? appSubsidizer.publicKey().buffer : subsidizer);
            expect(close.owner.toBuffer()).toEqual(appSubsidizer ? appSubsidizer.publicKey().buffer : subsidizer);
            i++;
        }
    });
}

test("getTransaction", async () => {
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

test("submitPayment", async() => {
    const internal = mock(InternalClient);

    let signReq: signRequest | undefined;
    let submitReq: submitRequest | undefined;
    when(internal.signTransaction(anything(), anything()))
        .thenCall((tx: Transaction, il?: commonpb.InvoiceList) => {
            // Make a copy of the transaction since we're modifying it
            signReq = {tx: Transaction.from(tx.serialize({
                requireAllSignatures: false,
                verifySignatures: false,
            })), il};
            const result = new SignTransactionResult();
            if (tx.feePayer!.toBuffer().equals(subsidizer)){
                tx.partialSign(new Account(subsidizerKey.secretKey()));
            }
            result.TxId = tx.signature ? tx.signature : undefined;
            return Promise.resolve(result);
        });
    when(internal.submitTransaction!(anything(), anything(), anything(), anything()))
        .thenCall((tx: Transaction, il?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            submitReq = {tx, il: il, commitment, dedupeId};
            const result = new SubmitTransactionResult();
            result.TxId = tx.signature!;
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
        const txId = await client.submitPayment(p);

        expect(signReq).toBeDefined();
        const signTx = signReq!.tx;
        expect(signTx.signatures).toHaveLength(2);
        expect(signTx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
        expect(signTx.signatures[0].signature).toBeNull();
        expect(signTx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(sender.kp.verify(signTx.serializeMessage(), signTx.signatures[1].signature!)).toBeTruthy();

        expect(signTx.instructions).toHaveLength(2);

        const memoInstruction = MemoInstruction.decodeMemo(signTx.instructions[0]);
        if (p.memo) {
            expect(memoInstruction.data).toEqual(p.memo);
        } else if (p.invoice) {
            const serialized = submitReq!.il!.serializeBinary();
            const buf = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex");
            const expected = Memo.new(1, p.type, 1, buf);

            expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
        } else {
            const expected = Memo.new(1, p.type, 1, Buffer.alloc(29));
            expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
        }

        const tokenInstruction = TokenInstruction.decodeTransfer(signTx.instructions[1]);
        expect(tokenInstruction.source.toBuffer()).toEqual(p.sender.publicKey().buffer);
        expect(tokenInstruction.dest.toBuffer()).toEqual(p.destination.buffer);
        expect(tokenInstruction.owner.toBuffer()).toEqual(p.sender.publicKey().buffer);
        expect(tokenInstruction.amount).toEqual(BigInt(p.quarks.toNumber()));

        expect(submitReq).toBeDefined();
        expect(submitReq!.dedupeId).toEqual(p.dedupeId);

        const submitTx = submitReq!.tx;
        expect(submitTx.signatures).toHaveLength(2);
        expect(submitTx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
        expect(subsidizerKey.kp.verify(submitTx.serializeMessage(), submitTx.signatures[0].signature!)).toBeTruthy();
        expect(submitTx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(sender.kp.verify(submitTx.serializeMessage(), submitTx.signatures[1].signature!)).toBeTruthy();

        expect(submitTx.serializeMessage().equals(signTx.serializeMessage())).toBeTruthy();

        // The returned txId should be the one in the submit request
        expect(txId.equals(submitTx.signature!)).toBeTruthy();
    }
});
test("submitPayment with no service subsidizer", async() => {
    const internal = mock(InternalClient);

    const submitReqs: submitRequest[] = [];

    const sender = PrivateKey.random();
    const dest = PrivateKey.random();
    const appSubsidizer = PrivateKey.random();

    when(internal.submitTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: Transaction, il?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            submitReqs.push({tx, il, commitment, dedupeId});

            const result = new SubmitTransactionResult();
            result.TxId = tx.signature!;
            return Promise.resolve(result);
        });

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

    const txId = await client.submitPayment(p);

    expect(submitReqs).toHaveLength(1);

    const request = submitReqs[0];
    expect(request).toBeDefined();

    const submitTx = request!.tx;
    expect(submitTx.signatures).toHaveLength(2);
    expect(submitTx.signatures[0].publicKey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
    expect(appSubsidizer.kp.verify(submitTx.serializeMessage(), submitTx.signatures[0].signature!)).toBeTruthy();
    expect(txId).toEqual(submitTx.signatures[0].signature!);

    expect(submitTx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(sender.kp.verify(submitTx.serializeMessage(), submitTx.signatures[1].signature!)).toBeTruthy();

    expect(submitTx.instructions).toHaveLength(2);

    const memoInstruction = MemoInstruction.decodeMemo(submitTx.instructions[0]);

    const expected = Memo.new(1, p.type, 1, Buffer.alloc(29));
    expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));

    const tokenInstruction = TokenInstruction.decodeTransfer(submitTx.instructions[1]);

    expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(tokenInstruction.dest.toBuffer()).toEqual(dest.publicKey().buffer);
    expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(tokenInstruction.amount).toEqual(BigInt(p.quarks.toNumber()));
});
test("submitPayment with preferred account resolution", async() => {
    const internal = mock(InternalClient);

    interface submitRequest {
        tx: Transaction,
        invoice?: commonpb.InvoiceList,
        commitment?: Commitment,
        dedupeId?: Buffer,
    }
    const requests: submitRequest[] = [];

    let attemptedSubmission = false;
    when(internal.submitTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: Transaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            requests.push({tx, invoice, commitment, dedupeId});

            const result = new SubmitTransactionResult();
            result.TxId = tx.signature!;
            if (!attemptedSubmission) {
                attemptedSubmission = true;

                const errors = new TransactionErrors();
                errors.TxError = new AccountDoesNotExist();
                result.Errors = errors;
            }
            return Promise.resolve(result);
        });

    const appSubsidizer = PrivateKey.random();
    const sender = PrivateKey.random();
    const dest = PrivateKey.random();
    const resolvedSender = PrivateKey.random();
    const resolvedDest = PrivateKey.random();
    const resolvedAccounts = new Map<string, PublicKey>([
        [sender.publicKey().toBase58(), resolvedSender.publicKey()],
        [dest.publicKey().toBase58(), resolvedDest.publicKey()],
    ]);

    when(internal.resolveTokenAccounts(anything(), anything()))
        .thenCall((key: PublicKey) => {
            const resolvedAccount = resolvedAccounts.get(key.toBase58());

            if (resolvedAccount) {
                const id = new commonpbv4.SolanaAccountId();
                id.setValue(resolvedAccount.buffer);

                const info = new accountpbv4.AccountInfo();
                info.setAccountId(id);
                return Promise.resolve([info]);
            }

            return Promise.resolve([]);
        });

    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);

    const p: Payment = {
        sender: sender,
        destination: dest.publicKey(),
        type: TransactionType.Spend,
        quarks: new BigNumber(11),
        subsidizer: appSubsidizer,
    };

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
    });

    let txId = await client.submitPayment(p);
    expect(txId.length).toEqual(64);
    expect(txId.equals(Buffer.alloc(64).fill(0))).toBeFalsy();
    expect(requests).toHaveLength(2);

    const resolved = [false, true];
    requests.forEach((request, i) => {
        expect(request).toBeDefined();

        const tx = request!.tx;
        expect(tx.signatures).toHaveLength(2);
        expect(tx.signatures[0].publicKey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
        expect(appSubsidizer.kp.verify(tx.serializeMessage(), tx.signatures[0].signature!)).toBeTruthy();

        expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

        expect(tx.instructions).toHaveLength(2);

        const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);

        const expected = Memo.new(1, p.type, 1, Buffer.alloc(29));
        expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));

        const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[1]);

        if (resolved[i]) {
            expect(tokenInstruction.source.toBuffer()).toEqual(resolvedSender.publicKey().buffer);
            expect(tokenInstruction.dest.toBuffer()).toEqual(resolvedDest.publicKey().buffer);
        } else {
            expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);
            expect(tokenInstruction.dest.toBuffer()).toEqual(dest.publicKey().buffer);
        }
        expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(tokenInstruction.amount).toEqual(BigInt(p.quarks.toNumber()));
    });

    txId = await client.submitPayment(p);
    expect(txId.length).toEqual(64);
    expect(txId.equals(Buffer.alloc(64).fill(0))).toBeFalsy();
    expect(requests).toHaveLength(3);
});
test("submitPayment with exact account resolution", async() => {
    const internal = mock(InternalClient);

    interface submitRequest {
        tx: Transaction,
        invoice?: commonpb.InvoiceList,
        commitment?: Commitment,
        dedupeId?: Buffer,
    }
    const requests: submitRequest[] = [];

    when(internal.submitTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: Transaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            requests.push({tx, invoice, commitment, dedupeId});

            return Promise.resolve({
                TxId: tx.signature!,
                Errors: {
                    TxError: new AccountDoesNotExist(),
                }
            });
        });

    const appSubsidizer = PrivateKey.random();
    const sender = PrivateKey.random();
    const dest = PrivateKey.random();

    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);

    const p: Payment = {
        sender: sender,
        destination: dest.publicKey(),
        type: TransactionType.Spend,
        quarks: new BigNumber(11),
        subsidizer: appSubsidizer,
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
    expect(tx.signatures[0].publicKey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
    expect(appSubsidizer.kp.verify(tx.serializeMessage(), tx.signatures[0].signature!)).toBeTruthy();

    expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

    expect(tx.instructions).toHaveLength(2);

    const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);

    const expected = Memo.new(1, p.type, 1, Buffer.alloc(29));
    expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));

    const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[1]);
    expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(tokenInstruction.dest.toBuffer()).toEqual(dest.publicKey().buffer);
    expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(tokenInstruction.amount).toEqual(BigInt(p.quarks.toNumber()));
});
test("submitPayment with sender create", async() => {
    const internal = mock(InternalClient);

    interface submitRequest {
        tx: Transaction,
        invoice?: commonpb.InvoiceList,
        commitment?: Commitment,
        dedupeId?: Buffer,
    }
    const requests: submitRequest[] = [];

    let attemptedSubmission = false;
    when(internal.submitTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: Transaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            requests.push({tx, invoice, commitment, dedupeId});

            const result = new SubmitTransactionResult();
            result.TxId = tx.signature!;
            if (!attemptedSubmission) {
                attemptedSubmission = true;

                const errors = new TransactionErrors();
                errors.TxError = new AccountDoesNotExist();
                result.Errors = errors;
            }
            return Promise.resolve(result);
        });

    const appSubsidizer = PrivateKey.random();
    const sender = PrivateKey.random();
    const dest = PrivateKey.random();
    const resolvedSender = PrivateKey.random();
    const resolvedAccounts = new Map<string, PublicKey>([
        [sender.publicKey().toBase58(), resolvedSender.publicKey()],
    ]);

    when(internal.resolveTokenAccounts(anything(), anything()))
        .thenCall((key: PublicKey) => {
            const resolvedAccount = resolvedAccounts.get(key.toBase58());

            if (resolvedAccount) {
                const id = new commonpbv4.SolanaAccountId();
                id.setValue(resolvedAccount.buffer);

                const info = new accountpbv4.AccountInfo();
                info.setAccountId(id);
                return Promise.resolve([info]);
            }

            return Promise.resolve([]);
        });

    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);
    setGetMinBalanceForRentExemptionResp(internal);

    const p: Payment = {
        sender: sender,
        destination: dest.publicKey(),
        type: TransactionType.Spend,
        quarks: new BigNumber(11),
        subsidizer: appSubsidizer,
    };

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
    });

    const txId = await client.submitPayment(p, Commitment.Single, AccountResolution.Preferred, AccountResolution.Preferred, true);
    expect(txId.length).toEqual(64);
    expect(txId.equals(Buffer.alloc(64).fill(0))).toBeFalsy();
    expect(requests).toHaveLength(2);

    // Initial request without resolution
    let request = requests[0];
    let tx = request!.tx;
    expect(tx.signatures).toHaveLength(2);
    expect(tx.signatures[0].publicKey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
    expect(appSubsidizer.kp.verify(tx.serializeMessage(), tx.signatures[0].signature!)).toBeTruthy();

    expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

    expect(tx.instructions).toHaveLength(2);

    let memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);

    let expected = Memo.new(1, p.type, 1, Buffer.alloc(29));
    expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));

    let tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[1]);

    expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(tokenInstruction.dest.toBuffer()).toEqual(dest.publicKey().buffer);
    expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(tokenInstruction.amount).toEqual(BigInt(p.quarks.toNumber()));

    // Second request with sender create
    request = requests[1];
    tx = request!.tx;
    expect(tx.signatures).toHaveLength(3);    // one more sig for account creation
    expect(tx.signatures[0].publicKey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
    expect(appSubsidizer.kp.verify(tx.serializeMessage(), tx.signatures[0].signature!)).toBeTruthy();

    expect(tx.signatures[2].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[2].signature!)).toBeTruthy();

    expect(tx.instructions).toHaveLength(6);

    memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);

    expected = Memo.new(1, p.type, 1, Buffer.alloc(29));
    expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));

    const create = SystemInstruction.decodeCreateAccount(tx.instructions[1]);
    expect(create.fromPubkey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
    expect(create.newAccountPubkey).toBeDefined();  // randomly generated, just make sure it exists
    expect(create.programId.equals(TOKEN_PROGRAM_ID)).toBeTruthy();
    expect(create.lamports).toEqual(minBalance);
    expect(create.space).toEqual(AccountSize);

    const init = TokenInstruction.decodeInitializeAccount(tx.instructions[2]);
    expect(init.account.equals(create.newAccountPubkey)).toBeTruthy();
    expect(init.mint.toBuffer()).toEqual(token);
    expect(init.owner.equals(create.newAccountPubkey));

    const closeAuth = TokenInstruction.decodeSetAuthority(tx.instructions[3]);
    expect(closeAuth.account.equals(create.newAccountPubkey)).toBeTruthy();
    expect(closeAuth.currentAuthority.equals(create.newAccountPubkey)).toBeTruthy();
    expect(closeAuth.authorityType).toEqual('CloseAccount');
    expect(closeAuth.newAuthority!.equals(appSubsidizer.publicKey().solanaKey())).toBeTruthy();

    const holderAuth = TokenInstruction.decodeSetAuthority(tx.instructions[4]);
    expect(holderAuth.account.equals(create.newAccountPubkey)).toBeTruthy();
    expect(holderAuth.currentAuthority.equals(create.newAccountPubkey)).toBeTruthy();
    expect(holderAuth.authorityType).toEqual('AccountOwner');
    expect(holderAuth.newAuthority!.equals(dest.publicKey().solanaKey())).toBeTruthy();

    tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[5]);

    expect(tokenInstruction.source.toBuffer()).toEqual(resolvedSender.publicKey().buffer);
    expect(tokenInstruction.dest.equals(create.newAccountPubkey)).toBeTruthy();
    expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(tokenInstruction.amount).toEqual(BigInt(p.quarks.toNumber()));
});
test("submitPayment invalid", async () => {
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
test("submitPayment sign errors", async() => {
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
    when(internal.signTransaction(anything(), anything()))
        .thenCall(() => {
            const invoiceError = new commonpb.InvoiceError();
            invoiceError.setOpIndex(0);
            invoiceError.setReason(reason);
            invoiceError.setInvoice(invoiceToProto(payment.invoice!));

            const result: SignTransactionResult = {
                TxId: Buffer.alloc(64),
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
});
test("submitPayment submit errors", async() => {
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
    when(internal.signTransaction(anything(), anything()))
        .thenCall((tx: Transaction) => {
            const result = new SignTransactionResult();
            if (tx.feePayer!.toBuffer().equals(subsidizer)){
                tx.partialSign(new Account(subsidizerKey.secretKey()));
            }
            result.TxId = tx.signature ? tx.signature : undefined;
            return Promise.resolve(result);
        });
    when(internal.submitTransaction(anything(), anything(), anything(), anything()))
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

    when(internal.submitTransaction(anything(), anything(), anything(), anything()))
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

    when(internal.submitTransaction(anything(), anything(), anything(), anything()))
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

test("submitEarnBatch", async() => {
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

    let signReq: signRequest | undefined;
    let submitReq: submitRequest | undefined;

    const internal = mock(InternalClient);
    when(internal.signTransaction(anything(), anything()))
        .thenCall((tx: Transaction, il?: commonpb.InvoiceList) => {
            // Make a copy of the transaction since we're modifying it

            signReq = {tx: Transaction.from(tx.serialize({
                requireAllSignatures: false,
                verifySignatures: false,
            })), il};

            const result = new SignTransactionResult();
            if (tx.feePayer!.toBuffer().equals(subsidizer)){
                tx.partialSign(new Account(subsidizerKey.secretKey()));
            }
            result.TxId = tx.signature ? tx.signature : undefined;
            return Promise.resolve(result);
        });

    when(internal.submitTransaction(anything(), anything(), anything(), anything()))
    .thenCall((tx: Transaction, il?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            submitReq = {tx, il, commitment, dedupeId};

            const result = new SubmitTransactionResult();
            result.TxId = tx.signature!;

            return Promise.resolve(result);
        });

    setGetServiceConfigResp(internal);
    setGetRecentBlockhashResp(internal);

    const client = new Client(Environment.Test, {
        appIndex: 1,
        internal: instance(internal),
    });

    for (const b of batches) {
        signReq = undefined;
        submitReq = undefined;

        const result = await client.submitEarnBatch(b);
        expect(result.txId.length).toEqual(64);
        expect(result.txId.equals(Buffer.alloc(64).fill(0))).toBeFalsy();
        expect(result.txError).toBeUndefined();
        expect(result.earnErrors).toBeUndefined();

        expect(signReq).toBeDefined();

        const signTx = signReq!.tx;
        expect(signTx.signatures).toHaveLength(2);
        expect(signTx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
        expect(signTx.signatures[0].signature).toBeNull();
        expect(signTx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(sender.kp.verify(signTx.serializeMessage(), signTx.signatures[1].signature!)).toBeTruthy();

        const memoInstruction = MemoInstruction.decodeMemo(signTx.instructions[0]);

        if (b.memo) {
            expect(memoInstruction.data).toEqual(b.memo);
        } else if (b.earns[0].invoice) {
            const serialized = submitReq!.il!.serializeBinary();
            const buf = Buffer.from(hash.sha224().update(serialized).digest('hex'), "hex");
            const expected = Memo.new(1, TransactionType.Earn, 1, buf);

            expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
        } else {
            // since we have an app index configured, we still expect a memo
            const expected = Memo.new(1, TransactionType.Earn, 1, Buffer.alloc(29));
            expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));
        }

        expect(signTx.instructions).toHaveLength(16);  // including memo

        for (let i = 0; i < 15; i++) {
            const tokenInstruction = TokenInstruction.decodeTransfer(signTx.instructions[i + 1]);
            expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);

            expect(tokenInstruction.dest.toBuffer()).toEqual(b.earns[i].destination.buffer);
            expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
            expect(tokenInstruction.amount).toEqual(BigInt((i + 1)));
        }

        expect(submitReq).toBeDefined();
        expect(submitReq!.dedupeId).toEqual(b.dedupeId);

        const submitTx = submitReq!.tx;
        expect(submitTx.signatures).toHaveLength(2);
        expect(submitTx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
        expect(subsidizerKey.kp.verify(submitTx.serializeMessage(), submitTx.signatures[0].signature!)).toBeTruthy();
        expect(submitTx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(sender.kp.verify(submitTx.serializeMessage(), submitTx.signatures[1].signature!)).toBeTruthy();

        expect(submitTx.serializeMessage()).toEqual(signTx.serializeMessage());
    }
});
test("submitEarnBatch with no service subsidizer", async() => {
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
        tx: Transaction,
        invoiceList?: commonpb.InvoiceList,
        commitment?: Commitment,
        dedupeId?: Buffer,
    }
    let request: submitRequest | undefined;

    const txId = Buffer.from("someid");
    when(internal.submitTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: Transaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
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

    const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);

    const expected = Memo.new(1, TransactionType.Earn, 1, Buffer.alloc(29));
    expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));

    expect(tx.instructions).toHaveLength(earnCount + 1);

    for (let i = 0; i < earnCount; i++) {
        const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[i + 1]);
            expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);
            expect(tokenInstruction.dest.toBuffer()).toEqual(earns[i].destination.buffer);
            expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
            expect(tokenInstruction.amount).toEqual(BigInt((i + 1)));
    }
});
test("submitEarnBatch with preferred account resolution", async() => {
    const internal = mock(InternalClient);

    const appSubsidizer = PrivateKey.random();
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
        tx: Transaction,
        invoiceList?: commonpb.InvoiceList,
        commitment?: Commitment,
        dedupeId?: Buffer,
    }
    const requests: submitRequest[] = [];

    let attemptedSubmission = false;
    when(internal.submitTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: Transaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
            requests.push({tx, invoiceList: invoice, commitment, dedupeId});

            if (!attemptedSubmission) {
                attemptedSubmission = true;
                return Promise.resolve({
                    TxId: tx.signature!,
                    Errors: {
                        TxError: new AccountDoesNotExist(),
                    },
                });
            } else {
                attemptedSubmission = false;  // reset for next request
                return Promise.resolve({
                    TxId: tx.signature!,
                });
            }
        });

    when(internal.resolveTokenAccounts(anything(), anything()))
        .thenCall((key: PublicKey) => {
            const resolvedAccount = resolvedAccounts.get(key.toBase58());

            if (resolvedAccount) {
                const id = new commonpbv4.SolanaAccountId();
                id.setValue(resolvedAccount.buffer);

                const info = new accountpbv4.AccountInfo();
                info.setAccountId(id);

                return Promise.resolve([info]);
            }

            return Promise.resolve([]);
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
        subsidizer: appSubsidizer,
    });

    expect(result.txId.length).toEqual(64);
    expect(result.txId.equals(Buffer.alloc(64).fill(0))).toBeFalsy();
    expect(result.txError).toBeUndefined();
    expect(result.earnErrors).toBeUndefined();

    expect(requests).toHaveLength(2);
    for (let reqId = 0; reqId < requests.length; reqId++) {
        const batchIndex = Math.floor(reqId / 2);
        const resolved = (reqId % 2) == 1;

        const req = requests[reqId];
        const tx = req.tx;

        expect(tx.signatures).toHaveLength(2);
        expect(tx.signatures[0].publicKey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
        expect(appSubsidizer.kp.verify(tx.serializeMessage(), tx.signatures[0].signature!)).toBeTruthy();
        expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

        const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);

        const expected = Memo.new(1, TransactionType.Earn, 1, Buffer.alloc(29));
        expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));

        expect(tx.instructions).toHaveLength(earnCount + 1);

        for (let i = 0; i < earnCount; i++) {
            const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[i + 1]);

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
test("submitEarnBatch with exact account resolution", async() => {
    const internal = mock(InternalClient);

    const appSubsidizer = PrivateKey.random();
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
        tx: Transaction,
        invoiceList?: commonpb.InvoiceList,
        commitment?: Commitment,
        dedupeId?: Buffer,
    }
    const requests: submitRequest[] = [];

    when(internal.submitTransaction(anything(), anything(), anything(), anything()))
        .thenCall((tx: Transaction, invoice?: commonpb.InvoiceList, commitment?: Commitment, dedupeId?: Buffer) => {
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
        subsidizer: appSubsidizer,
    }, Commitment.Single, AccountResolution.Exact, AccountResolution.Exact);
    expect(result.txId).toEqual(Buffer.alloc(64));
    expect(result.txError).toBeInstanceOf(AccountDoesNotExist);
    expect(result.earnErrors).toBeUndefined();

    expect(requests).toHaveLength(1);
    const req = requests[0];
    const tx = req.tx;

    expect(tx.signatures).toHaveLength(2);
    expect(tx.signatures[0].publicKey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
    expect(appSubsidizer.kp.verify(tx.serializeMessage(), tx.signatures[0].signature!)).toBeTruthy();
    expect(tx.signatures[1].publicKey.toBuffer()).toEqual(sender.publicKey().buffer);
    expect(sender.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

    const memoInstruction = MemoInstruction.decodeMemo(tx.instructions[0]);

    const expected = Memo.new(1, TransactionType.Earn, 1, Buffer.alloc(29));
    expect(memoInstruction.data).toEqual(expected.buffer.toString("base64"));

    expect(tx.instructions).toHaveLength(earnCount + 1);

    for (let i = 0; i < earnCount; i++) {
        const tokenInstruction = TokenInstruction.decodeTransfer(tx.instructions[i + 1]);
        expect(tokenInstruction.source.toBuffer()).toEqual(sender.publicKey().buffer);

        expect(tokenInstruction.dest.toBuffer()).toEqual(earns[i].destination.buffer);
        expect(tokenInstruction.owner.toBuffer()).toEqual(sender.publicKey().buffer);
        expect(tokenInstruction.amount).toEqual(BigInt((i + 1)));
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
    when(internal.signTransaction(anything(), anything()))
        .thenCall((tx: Transaction) => {
            const result = new SignTransactionResult();
            if (tx.feePayer!.toBuffer().equals(subsidizer)){
                tx.partialSign(new Account(subsidizerKey.secretKey()));
            }
            result.TxId = tx.signature ? tx.signature : undefined;
            return Promise.resolve(result);
        });
    when(internal.submitTransaction(anything(), anything(), anything(), anything()))
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
test("submitEarnBatch sign invoice errors", async() => {
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

    when(internal.signTransaction(anything(), anything()))
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
test("submitEarnBatch submit invoice errors", async() => {
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

    when(internal.signTransaction(anything(), anything()))
        .thenCall((tx: Transaction) => {
            const result = new SignTransactionResult();
            if (tx.feePayer!.toBuffer().equals(subsidizer)){
                tx.partialSign(new Account(subsidizerKey.secretKey()));
            }
            result.TxId = tx.signature ? tx.signature : undefined;
            return Promise.resolve(result);
        });
    when(internal.submitTransaction(anything(), anything(), anything(), anything()))
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
