import { PublicKey, PrivateKey } from "../src/keys";

test("stellar_keys", () => {
    const pub = "GCABWU4FHL3RGOIWCX5TOVLIAMLEU2YXXLCMHVXLDOFHKLNLGCSBRJYP";
    const priv = "SCZ4KGTCMAFIJQCCJDMMKDFUB7NYV56VBNEU7BKMR4PQFUETJCWLV6GN";

    const pubKey = PublicKey.fromString(pub);
    const privKey = PrivateKey.fromString(priv);

    expect(privKey.equals(PrivateKey.fromString(priv))).toBeTruthy();
    expect(privKey.publicKey()).toStrictEqual(pubKey);
    expect(privKey.publicKey().equals(pubKey)).toBeTruthy();
    expect(privKey.stellarSeed()).toBe(priv);
    expect(privKey.publicKey().stellarAddress()).toBe(pub);
})
