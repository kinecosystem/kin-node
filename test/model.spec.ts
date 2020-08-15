import { xdr } from "stellar-base";
import { xdrInt64ToBigNumber, kinToQuarks, quarksToKin } from "../src";
import BigNumber from "bignumber.js";

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
    ])
    validCases.forEach((expected, input) => {
        expect(kinToQuarks(input)).toStrictEqual(new BigNumber(expected));
        expect(quarksToKin(expected)).toStrictEqual(new BigNumber(input).toString());
    })

    const roundedCases = new Map<string, string>([
        ["0.000001", "0"],
        ["0.000015", "1"],
        ["0.000018", "1"],
    ]);
    roundedCases.forEach((expected, input) => {
        expect(kinToQuarks(input)).toStrictEqual(new BigNumber(expected));
    })
})
