import { xdr } from "stellar-base";
import { xdrInt64ToBigNumber } from "../src";
import BigNumber from "bignumber.js";

test("XdrInt64ToBigNumber", () => {
    const i64 = new xdr.Int64(1145307136, 572653568);
    expect(xdrInt64ToBigNumber(i64)).toStrictEqual(new BigNumber("2459528347643019264"));
});
