import BigNumber from "bignumber.js";
import { Invoice, invoiceToProto, PublicKey } from "..";
import modelpbv3 from "@kin-beta/agora-api/node/common/v3/model_pb";
import modelpb from "@kin-beta/agora-api/node/common/v4/model_pb";
import txpb from "@kin-beta/agora-api/node/transaction/v4/transaction_service_pb";

export interface InvoiceListParams {
    invoices: Invoice[]
}

export interface PaymentParams {
    source: PublicKey
    destination: PublicKey
    amount: BigNumber
}


export interface HistoryItemParams {
    transactionId: Buffer
    cursor: Buffer | undefined
    stellarTxEnvelope: Buffer | undefined
    solanaTx: Buffer | undefined
    payments: PaymentParams[]
    invoices: Invoice[]
}

export function createInvoiceList(params: InvoiceListParams): modelpbv3.InvoiceList {
    const invoiceList = new modelpbv3.InvoiceList();
    const invoices: modelpbv3.Invoice[] = [];
    params.invoices.forEach(invoice => {
        invoices.push(invoiceToProto(invoice));
    });
    invoiceList.setInvoicesList(invoices);
    return invoiceList;
}

export function createPayment(params: PaymentParams): txpb.HistoryItem.Payment {
    const payment = new txpb.HistoryItem.Payment();

    const source = new modelpb.TransactionId();
    source.setValue(params.source.buffer);
    payment.setSource(source);

    const destination = new modelpb.TransactionId();
    destination.setValue(params.destination.buffer);
    payment.setDestination(destination);

    payment.setAmount(params.amount.toNumber());

    return payment;
}


export function createHistoryItem(params: HistoryItemParams): txpb.HistoryItem {
    const item = new txpb.HistoryItem();

    const txId = new modelpb.TransactionId();
    txId.setValue(params.transactionId);
    item.setTransactionId(txId);

    if (params.cursor) {
        const cursor = new txpb.Cursor();
        cursor.setValue(params.cursor);
        item.setCursor(cursor);
    }

    if (params.stellarTxEnvelope) {
        const stellarTx = new modelpb.StellarTransaction();
        stellarTx.setEnvelopeXdr(params.stellarTxEnvelope);
        item.setStellarTransaction(stellarTx);
    }

    if (params.solanaTx) {
        const solanaTx = new modelpb.Transaction();
        solanaTx.setValue(params.solanaTx);
        item.setSolanaTransaction(solanaTx);
    }

    const payments: txpb.HistoryItem.Payment[] = [];
    params.payments.forEach(payment => {
        payments.push(createPayment(payment));
    });
    item.setPaymentsList(payments);

    if (params.invoices.length > 0) {
        item.setInvoiceList(createInvoiceList({ invoices: params.invoices }));
    }
    return item;
}
