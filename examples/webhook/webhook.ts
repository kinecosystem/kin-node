import bs58 from "bs58";
import express from "express";
import { Environment, PrivateKey } from "../../src";
import { Event, EventsHandler, SignTransactionHandler, SignTransactionRequest, SignTransactionResponse } from "../../src/webhook";

const port = process.env["PORT"] || 8080;
const secret = process.env["WEBHOOK_SECRET"];
const webhookSeed = process.env["WEBHOOK_SEED"];
if (!webhookSeed) {
    console.log("missing webhook seed");
    process.exit(1);
}

const whitelistKey = PrivateKey.fromString(webhookSeed);

const app = express();

app.use("/events", express.json());
app.use("/events", EventsHandler((events: Event[]) => {
    for (const e of events) {
        console.log(`received event: ${JSON.stringify(e)}`);
    }
}, secret));

app.use("/sign_transaction", express.json());
app.use("/sign_transaction", SignTransactionHandler(Environment.Test, (req: SignTransactionRequest, resp: SignTransactionResponse) => {
    console.log(`sign request for <'${req.userId}', '${req.userPassKey}'>: ${bs58.encode(req.txId())}`);

    for (let i = 0; i < req.payments.length; i++) {
        const p = req.payments[i];

        // Double check that the transaction isn't trying to impersonate us
        if (p.sender.equals(whitelistKey.publicKey())) {
            resp.reject();
            return;
        }

        // In this example, we don't want to whitelist transactions that aren't sending
        // kin to us.
        //
        // Note: this is purely demonstrating WrongDestination. Some apps may wish to
        // whitelist everything.
        if (!p.destination.equals(whitelistKey.publicKey())) {
            resp.markWrongDestination(i);
        }

        if (p.invoice) {
            for (const item of p.invoice.Items) {
                if (!item.sku) {
                    // Note: in general the sku is optional. However, in this example we
                    //       mark it as SkuNotFound to facilitate testing.
                    resp.markSkuNotFound(i);
                }
            }
        }
    }

    // Note: if we _don't_ do this check here, the SDK won't send back a signed
    //       transaction if this is set.
    if (resp.isRejected()) {
        return;
    }

    resp.sign(whitelistKey);
}, secret));


app.listen(port, () => {
    console.log(`server started at http://localhost:${ port }`);
});
