import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import txpb from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_pb";
import { ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as solanaweb3 from "@solana/web3.js";
import BigNumber from "bignumber.js";
import hash from "hash.js";
import { xdr } from "stellar-base";
import { v4 as uuidv4 } from 'uuid';
import { invoiceToProto, kinToQuarks, Memo, parseTransaction, PrivateKey, protoToInvoice, quarksToKin, TransactionState, TransactionType, txDataFromProto, xdrInt64ToBigNumber } from "../src";
import { createHistoryItem, createInvoiceList } from "../src/proto/utils";
import { MemoProgram } from "../src/solana/memo-program";
import { AccountSize } from "../src/solana/token-program";

test("XdrInt64ToBigNumber", () => {
    const i64 = new xdr.Int64(1145307136, 572653568);
    expect(xdrInt64ToBigNumber(i64)).toStrictEqual(new BigNumber("2459528347643019264"));
});

test("kin to quark conversion", () => {
    const validCases = new Map<string, string>([
        ["0.00001", "1"],
        ["0.00002", "2"],
        ["1", "1e5"],
        ["2", "2e5"],
        // 10 trillion, more than what's in cicrulation
        ["10000000000000", "1e18"],
    ]);
    validCases.forEach((expected, input) => {
        expect(kinToQuarks(input)).toStrictEqual(new BigNumber(expected));
        expect(quarksToKin(expected)).toStrictEqual(new BigNumber(input).toString());
    });

    const roundedCases = new Map<string, string>([
        ["0.000001", "0"],
        ["0.000015", "1"],
        ["0.000018", "1"],
    ]);
    roundedCases.forEach((expected, input) => {
        expect(kinToQuarks(input)).toStrictEqual(new BigNumber(expected));
    });
});

test("txDataFromProto", () => {
    const account1 = PrivateKey.random();
    const account2 = PrivateKey.random();
    const owner = PrivateKey.random();
    const recentBlockhash = new solanaweb3.Account().publicKey.toBase58();
    const invoices = [
        {
            Items: [
                {
                    title: "t1",
                    description: "d2",
                    amount: new BigNumber(10),
                },
            ]
        },
        {
            Items: [
                {
                    title: "t3",
                    description: "d4",
                    amount: new BigNumber(15),
                },
            ]
        },
    ];

    const serializedInvoiceList = createInvoiceList({ invoices: invoices }).serializeBinary();
    const fk = Buffer.from(hash.sha224().update(serializedInvoiceList).digest('hex'), "hex");
    const kinMemo = Memo.new(1, TransactionType.P2P, 0, fk);
    const tx = new solanaweb3.Transaction({ 
        feePayer: owner.publicKey().solanaKey(),
        recentBlockhash: recentBlockhash,
     }).add(
        MemoProgram.memo({ data: kinMemo.buffer.toString('base64') }),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            account1.publicKey().solanaKey(),
            account2.publicKey().solanaKey(),
            owner.publicKey().solanaKey(),
            [],
            10,
        ),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            account2.publicKey().solanaKey(),
            account1.publicKey().solanaKey(),
            owner.publicKey().solanaKey(),
            [],
            15,
        )
    );
    tx.setSigners(owner.publicKey().solanaKey());
    owner.kp.secret();
    tx.sign(new solanaweb3.Account(owner.secretKey()));

    const historyItem = createHistoryItem({
        transactionId: Buffer.from('someid'),
        cursor: undefined,
        stellarTxEnvelope: undefined,
        solanaTx: tx.serialize(),
        payments: [
            {
                source: account1.publicKey(),
                destination: account2.publicKey(),
                amount: new BigNumber(10),
            },
            {
                source: account2.publicKey(),
                destination: account1.publicKey(),
                amount: new BigNumber(15),
            },
        ],
        invoices: invoices,
    });

    const txData = txDataFromProto(historyItem, txpb.GetTransactionResponse.State.SUCCESS);
    expect(txData.txId).toEqual(Buffer.from('someid'));
    expect(txData.txState).toEqual(TransactionState.Success);
    expect(txData.payments).toHaveLength(2);

    expect(txData.payments[0].sender.buffer).toEqual(account1.kp.rawPublicKey());
    expect(txData.payments[0].destination.buffer).toEqual(account2.kp.rawPublicKey());
    expect(txData.payments[0].type).toEqual(TransactionType.P2P);
    expect(txData.payments[0].quarks).toEqual("10");
    expect(invoiceToProto(txData.payments[0].invoice!).serializeBinary()).toEqual(invoiceToProto(invoices[0]).serializeBinary());
    expect(txData.payments[0].memo).toBeUndefined();

    expect(txData.payments[1].sender.buffer).toEqual(account2.kp.rawPublicKey());
    expect(txData.payments[1].destination.buffer).toEqual(account1.kp.rawPublicKey());
    expect(txData.payments[1].type).toEqual(TransactionType.P2P);
    expect(txData.payments[1].quarks).toEqual("15");
    expect(invoiceToProto(txData.payments[1].invoice!).serializeBinary()).toEqual(invoiceToProto(invoices[1]).serializeBinary());
    expect(txData.payments[0].memo).toBeUndefined();
});

test("txDataFromProto no invoices", () => {
    const account1 = PrivateKey.random();
    const account2 = PrivateKey.random();
    const owner = PrivateKey.random();
    const recentBlockhash = new solanaweb3.Account().publicKey.toBase58();
    const kinMemo = Memo.new(1, TransactionType.P2P, 0, Buffer.alloc(0));
    const tx = new solanaweb3.Transaction({ 
        feePayer: owner.publicKey().solanaKey(),
        recentBlockhash: recentBlockhash,
     }).add(
        MemoProgram.memo({ data: kinMemo.buffer.toString('base64') }),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            account1.publicKey().solanaKey(),
            account2.publicKey().solanaKey(),
            owner.publicKey().solanaKey(),
            [],
            10,
        ),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            account2.publicKey().solanaKey(),
            account1.publicKey().solanaKey(),
            owner.publicKey().solanaKey(),
            [],
            15,
        ),
    );
    tx.setSigners(owner.publicKey().solanaKey());
    owner.kp.secret();
    tx.sign(new solanaweb3.Account(owner.secretKey()));

    const historyItem = createHistoryItem({
        transactionId: Buffer.from('someid'),
        cursor: undefined,
        stellarTxEnvelope: undefined,
        solanaTx: tx.serialize(),
        payments: [
            {
                source: account1.publicKey(),
                destination: account2.publicKey(),
                amount: new BigNumber(10),
            },
            {
                source: account2.publicKey(),
                destination: account1.publicKey(),
                amount: new BigNumber(15),
            },
        ],
        invoices: [],
    });

    const txData = txDataFromProto(historyItem, txpb.GetTransactionResponse.State.SUCCESS);
    expect(txData.txId).toEqual(Buffer.from('someid'));
    expect(txData.txState).toEqual(TransactionState.Success);
    expect(txData.payments).toHaveLength(2);

    expect(txData.payments[0].sender.buffer).toEqual(account1.kp.rawPublicKey());
    expect(txData.payments[0].destination.buffer).toEqual(account2.kp.rawPublicKey());
    expect(txData.payments[0].type).toEqual(TransactionType.P2P);
    expect(txData.payments[0].quarks).toEqual("10");
    expect(txData.payments[0].invoice).toBeUndefined();
    expect(txData.payments[0].memo).toBeUndefined();

    expect(txData.payments[1].sender.buffer).toEqual(account2.kp.rawPublicKey());
    expect(txData.payments[1].destination.buffer).toEqual(account1.kp.rawPublicKey());
    expect(txData.payments[1].type).toEqual(TransactionType.P2P);
    expect(txData.payments[1].quarks).toEqual("15");
    expect(txData.payments[1].invoice).toBeUndefined();
    expect(txData.payments[1].memo).toBeUndefined();
});

test("txDataFromProto invoice payment count mismatch", () => {
    const account1 = PrivateKey.random();
    const account2 = PrivateKey.random();
    const owner = PrivateKey.random();
    const recentBlockhash = new solanaweb3.Account().publicKey.toBase58();
    const invoices = [
        {
            Items: [
                {
                    title: "t1",
                    description: "d2",
                    amount: new BigNumber(10),
                },
            ]
        },
    ];

    const serializedInvoiceList = createInvoiceList({ invoices: invoices }).serializeBinary();
    const fk = Buffer.from(hash.sha224().update(serializedInvoiceList).digest('hex'), "hex");
    const kinMemo = Memo.new(1, TransactionType.P2P, 0, fk);
    const tx = new solanaweb3.Transaction({ 
        feePayer: owner.publicKey().solanaKey(),
        recentBlockhash: recentBlockhash,
     }).add(
        MemoProgram.memo({ data: kinMemo.buffer.toString('base64') }),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            account1.publicKey().solanaKey(),
            account2.publicKey().solanaKey(),
            owner.publicKey().solanaKey(),
            [],
            10,
        ),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            account2.publicKey().solanaKey(),
            account1.publicKey().solanaKey(),
            owner.publicKey().solanaKey(),
            [],
            15,
        ),
    );
    tx.setSigners(owner.publicKey().solanaKey());
    owner.kp.secret();
    tx.sign(new solanaweb3.Account(owner.secretKey()));

    const historyItem = createHistoryItem({
        transactionId: Buffer.from('someid'),
        cursor: undefined,
        stellarTxEnvelope: undefined,
        solanaTx: tx.serialize(),
        payments: [
            {
                source: account1.publicKey(),
                destination: account2.publicKey(),
                amount: new BigNumber(10),
            },
            {
                source: account2.publicKey(),
                destination: account1.publicKey(),
                amount: new BigNumber(15),
            },
        ],
        invoices: invoices,
    });

    try {
        txDataFromProto(historyItem, txpb.GetTransactionResponse.State.SUCCESS);
        fail();
    } catch (err) {
        expect(err.stack).toContain("number of invoices");
    }
});

test("parseTransaction transfers no invoices", () => {
    const keys = generateKeys(5);

    const tx = new solanaweb3.Transaction({
        feePayer: keys[0],
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[1],
            keys[2],
            keys[3],
            [],
            10,
        ),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[2],
            keys[3],
            keys[4],
            [],
            20,
        ),
    );
    
    const [creations, payments] = parseTransaction(tx);
    expect(creations.length).toEqual(0);
    expect(payments.length).toEqual(2);

    for (let i = 0; i < 2; i++) {
        expect(payments[i].sender.solanaKey().equals(keys[1+i])).toBeTruthy();
        expect(payments[i].destination.solanaKey().equals(keys[2+i])).toBeTruthy();
        expect(payments[i].type).toEqual(TransactionType.Unknown);
        expect(payments[i].quarks).toEqual(((1+i)*10).toString());
        expect(payments[i].invoice).toBeUndefined();
        expect(payments[i].memo).toBeUndefined();
    }
});

test("parseTransaction transfers with invoices", () => {
    const keys = generateKeys(5);

    // Single memo
    const [memoInstruction, il] = getInvoiceMemoInstruction(TransactionType.Spend, 10, 2);
    let tx = new solanaweb3.Transaction({
        feePayer: keys[0],
    }).add(
        memoInstruction,
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[1],
            keys[2],
            keys[3],
            [],
            10,
        ),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[2],
            keys[3],
            keys[4],
            [],
            20,
        ),
    );

    let [creations, payments] = parseTransaction(tx, il);
    expect(creations.length).toEqual(0);
    expect(payments.length).toEqual(2);

    for (let i = 0; i < 2; i++) {
        expect(payments[i].sender.solanaKey().equals(keys[1+i])).toBeTruthy();
        expect(payments[i].destination.solanaKey().equals(keys[2+i])).toBeTruthy();
        expect(payments[i].type).toEqual(TransactionType.Spend);
        expect(payments[i].quarks).toEqual(((1+i)*10).toString());
        expect(payments[i].invoice).toEqual(protoToInvoice(il.getInvoicesList()[i]));
        expect(payments[i].memo).toBeUndefined();
    }
    
    // Multiple memos
    const [memoInstruction1, il1] = getInvoiceMemoInstruction(TransactionType.Spend, 10, 1);
    const [memoInstruction2] = getInvoiceMemoInstruction(TransactionType.P2P, 10, 1);

    tx = new solanaweb3.Transaction({
        feePayer: keys[0],
    }).add(
        memoInstruction1,
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[1],
            keys[2],
            keys[3],
            [],
            10,
        ),
        memoInstruction2,
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[2],
            keys[3],
            keys[4],
            [],
            20,
        ),
    );
    
    [creations, payments] = parseTransaction(tx, il1);
    expect(creations.length).toEqual(0);
    expect(payments.length).toEqual(2);

    const expectedInvoices = [il1.getInvoicesList()[0], undefined];
    const expectedTypes = [TransactionType.Spend, TransactionType.P2P];
        
    for (let i = 0; i < 2; i++) {
        expect(payments[i].sender.solanaKey().equals(keys[1+i])).toBeTruthy();
        expect(payments[i].destination.solanaKey().equals(keys[2+i])).toBeTruthy();
        expect(payments[i].type).toEqual(expectedTypes[i]);
        expect(payments[i].quarks).toEqual(((1+i)*10).toString());
        if (expectedInvoices[i]) {
            expect(payments[i].invoice).toEqual(protoToInvoice(expectedInvoices[i]!));
        } else {
            expect(payments[i].invoice).toBeUndefined();
        }
        expect(payments[i].memo).toBeUndefined();
    }
});

test("parseTransaction with text memo", () => {
    const keys = generateKeys(5);
    
    // Single memo
    let tx = new solanaweb3.Transaction({
        feePayer: keys[0],
    }).add(
        MemoProgram.memo({data: '1-test'}),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[1],
            keys[2],
            keys[3],
            [],
            10,
        ),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[2],
            keys[3],
            keys[4],
            [],
            20,
        ),
    );

    let [creations, payments] = parseTransaction(tx);
    expect(creations.length).toEqual(0);
    expect(payments.length).toEqual(2);

    for (let i = 0; i < 2; i++) {
        expect(payments[i].sender.solanaKey().equals(keys[1+i])).toBeTruthy();
        expect(payments[i].destination.solanaKey().equals(keys[2+i])).toBeTruthy();
        expect(payments[i].type).toEqual(TransactionType.Unknown);
        expect(payments[i].quarks).toEqual(((1+i)*10).toString());
        expect(payments[i].invoice).toBeUndefined();
        expect(payments[i].memo).toEqual('1-test');
    }
    
    // Multiple memos
    const expectedMemos = ['1-test-alpha', '1-test-beta'];

    tx = new solanaweb3.Transaction({
        feePayer: keys[0],
    }).add(
        MemoProgram.memo({data: expectedMemos[0]}),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[1],
            keys[2],
            keys[3],
            [],
            10,
        ),
        MemoProgram.memo({data: expectedMemos[1]}),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[2],
            keys[3],
            keys[4],
            [],
            20,
        ),
    );
    
    [creations, payments] = parseTransaction(tx);
    expect(creations.length).toEqual(0);
    expect(payments.length).toEqual(2);

    for (let i = 0; i < 2; i++) {
        expect(payments[i].sender.solanaKey().equals(keys[1+i])).toBeTruthy();
        expect(payments[i].destination.solanaKey().equals(keys[2+i])).toBeTruthy();
        expect(payments[i].type).toEqual(TransactionType.Unknown);
        expect(payments[i].quarks).toEqual(((1+i)*10).toString());
        expect(payments[i].invoice).toBeUndefined();
        expect(payments[i].memo).toEqual(expectedMemos[i]);  
    }
});

test("parseTransaction create without account holder auth", async() => {
    const [subsidizer, wallet, mint] = generateKeys(3);

    const [createInstructions, addr] = await generateCreateInstructions(subsidizer, wallet, mint);
    const assoc = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, mint, wallet);
    const createAssocInstruction = Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mint,
        assoc,
        wallet,
        subsidizer,
    );

    const txs = [
        new solanaweb3.Transaction({
            feePayer: subsidizer,
        }).add(
            ...createInstructions.slice(0, 3)
        ),
        new solanaweb3.Transaction({
            feePayer: subsidizer,
        }).add(
            createAssocInstruction,
            Token.createSetAuthorityInstruction(
                TOKEN_PROGRAM_ID,
                assoc,
                subsidizer,
                'CloseAccount',
                assoc,
                [],
            ),
        ),
    ];

    for (let i = 0; i < txs.length; i++) {
        const [creations, payments] = parseTransaction(txs[i]);
        expect(creations.length).toEqual(1);
        expect(payments.length).toEqual(0);

        if (i === 0) {
            expect(creations[0].owner).toBeDefined();  // randomly generated
            expect(creations[0].address.solanaKey().equals(addr)).toBeTruthy();
        } else {
            expect(creations[0].owner.solanaKey().equals(wallet)).toBeTruthy();
            expect(creations[0].address.solanaKey().equals(assoc)).toBeTruthy();
        }
    }
});

test("parseTransaction create without close auth", async() => {
    const [subsidizer, wallet, mint] = generateKeys(3);

    const [createInstructions, addr] = await generateCreateInstructions(subsidizer, wallet, mint);
    const assoc = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, mint, wallet);
    const createAssocInstruction = Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mint,
        assoc,
        wallet,
        subsidizer,
    );

    const txs = [
        new solanaweb3.Transaction({
            feePayer: subsidizer,
        }).add(
            ...createInstructions.slice(0, 2)
        ),
        new solanaweb3.Transaction({
            feePayer: subsidizer,
        }).add(
            createAssocInstruction,
        ),
    ];

    for (let i = 0; i < txs.length; i++) {
        try {
            parseTransaction(txs[i]);
            fail();
        } catch (error) {
            expect(error.toString()).toContain('missing SplToken::SetAuthority(Close) instruction');
        }
    }
});

test("parseTransaction invalid memo combinations", () => {
    const keys = generateKeys(5);

    // Invalid transaction type combinations
    let [memoInstruction1] = getInvoiceMemoInstruction(TransactionType.Earn, 10, 1);
    [TransactionType.Spend, TransactionType.P2P].forEach(type => {
        const [memoInstruction2] = getInvoiceMemoInstruction(type, 10, 1);
        const tx = new solanaweb3.Transaction({
            feePayer:keys[0],
        }).add(
            memoInstruction1,
            Token.createTransferInstruction(
                TOKEN_PROGRAM_ID,
                keys[1],
                keys[2],
                keys[3],
                [],
                10,
            ),
            memoInstruction2,
            Token.createTransferInstruction(
                TOKEN_PROGRAM_ID,
                keys[2],
                keys[3],
                keys[4],
                [],
                20,
            ),
        );

        try {
            parseTransaction(tx);
            fail();
        } catch (error) {
            expect(error.toString()).toContain('cannot mix earns with P2P/spends');
        }
    });
    
    // Mixed app IDs
    memoInstruction1 = MemoProgram.memo({data: '1-kik'});
    let memoInstruction2 = MemoProgram.memo({data: '1-kin'});
    
    let tx = new solanaweb3.Transaction({
        feePayer:keys[0],
    }).add(
        memoInstruction1,
        memoInstruction2,
    );

    try {
        parseTransaction(tx);
        fail();
    } catch (error) {
        expect(error.toString()).toContain('multiple app IDs');
    }

    // Mixed app indexes
    [memoInstruction1] = getInvoiceMemoInstruction(TransactionType.Earn, 10, 1);
    [memoInstruction2] = getInvoiceMemoInstruction(TransactionType.Earn, 11, 1);

    tx = new solanaweb3.Transaction({
        feePayer:keys[0],
    }).add(
        memoInstruction1,
        memoInstruction2,
    );

    try {
        parseTransaction(tx);
        fail();
    } catch (error) {
        expect(error.toString()).toContain('multiple app indexes');
    }

    // No memos match the invoice list
    let il = generateInvoiceList(2);
    let [memoInstruction] = getInvoiceMemoInstruction(TransactionType.Earn, 10, 1);
    tx = new solanaweb3.Transaction({
        feePayer: keys[0],
    }).add(
        memoInstruction, 
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[1],
            keys[2],
            keys[3],
            [],
            10,
        ),
        memoInstruction,
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[2],
            keys[3],
            keys[4],
            [],
            20,
        ),
    );

    try {
        parseTransaction(tx, il);
        fail();
    } catch (error) {
        expect(error.toString()).toContain('invoice list does not match exactly to one memo in the transaction');
    }

    // Too many memos match the invoice list
    [memoInstruction, il] = getInvoiceMemoInstruction(TransactionType.Earn, 10, 2);
    tx = new solanaweb3.Transaction({
        feePayer: keys[0],
    }).add(
        memoInstruction,
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[1],
            keys[2],
            keys[3],
            [],
            10,
        ),
        memoInstruction,
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[2],
            keys[3],
            keys[4],
            [],
            20,
        ),
    );

    try {
        parseTransaction(tx, il);
        fail();
    } catch (error) {
        expect(error.toString()).toContain('invoice list does not match exactly to one memo in the transaction');
    }

    // Too many transfers for the invoice list
    [memoInstruction, il] = getInvoiceMemoInstruction(TransactionType.Earn, 10, 1);
    tx = new solanaweb3.Transaction({
        feePayer: keys[0],
    }).add(
        memoInstruction,
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[1],
            keys[2],
            keys[3],
            [],
            10,
        ),
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[2],
            keys[3],
            keys[4],
            [],
            20,
        ),
    );

    try {
        parseTransaction(tx, il);
        fail();
    } catch (error) {
        expect(error.toString()).toContain('invoice list doesn\'t have sufficient invoicesi for this transaction');
    }

    // Too few transfers for the invoice list
    [memoInstruction, il] = getInvoiceMemoInstruction(TransactionType.Earn, 10, 2);
    tx = new solanaweb3.Transaction({
        feePayer: keys[0],
    }).add(
        memoInstruction,
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            keys[1],
            keys[2],
            keys[3],
            [],
            10,
        ),
    );

    try {
        parseTransaction(tx, il);
        fail();
    } catch (error) {
        expect(error.toString()).toContain('does not match number of transfers referencing the invoice list');
    }
});

function generateKeys(count: number) {
    return Array(count).fill(undefined).map(() => PrivateKey.random().publicKey().solanaKey());
}

function getInvoiceMemoInstruction(txType: TransactionType, appIndex: number, transferCount: number): [solanaweb3.TransactionInstruction, commonpb.InvoiceList] {
    const invoiceList = generateInvoiceList(transferCount);
    const serializedInvoiceList = invoiceList.serializeBinary();
    const fk = Buffer.from(hash.sha224().update(serializedInvoiceList).digest('hex'), "hex");
    const agoraMemo = Memo.new(1, txType, appIndex, fk);
    return [MemoProgram.memo({
        data: agoraMemo.buffer.toString("base64")
    }), invoiceList];
}

async function generateCreateInstructions(subsidizer: solanaweb3.PublicKey, wallet: solanaweb3.PublicKey, mint: solanaweb3.PublicKey): Promise<[solanaweb3.TransactionInstruction[], solanaweb3.PublicKey]> {
    const addr = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, mint, wallet);
    const pub = PrivateKey.random().publicKey().solanaKey();
    const instructions = [
        solanaweb3.SystemProgram.createAccount({
            fromPubkey: subsidizer,
            newAccountPubkey: addr,
            lamports: 10,
            space: AccountSize,
            programId: TOKEN_PROGRAM_ID,
        }),
        Token.createInitAccountInstruction(
            TOKEN_PROGRAM_ID,
            mint,
            addr,
            pub,
        ),
        Token.createSetAuthorityInstruction(
            TOKEN_PROGRAM_ID,
            addr,
            subsidizer,
            'CloseAccount',
            pub,
            [],
        ),
        Token.createSetAuthorityInstruction(
            TOKEN_PROGRAM_ID,
            addr,
            wallet,
            'AccountOwner',
            pub,
            [],
        )
    ];
    return [instructions, addr];
}

function generateInvoiceList(transferCount: number): commonpb.InvoiceList {
    const invoices = [];
    for (let i = 0; i < transferCount; i++) {
        const item = new commonpb.Invoice.LineItem();
        item.setTitle(uuidv4().toString());
        const invoice = new commonpb.Invoice();
        invoice.setItemsList([item]);
        invoices.push(invoice);
    }
    const invoiceList = new commonpb.InvoiceList();
    invoiceList.setInvoicesList(invoices);
    return invoiceList;
}