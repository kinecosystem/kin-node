# Changelog

## Unreleased
- Add Kin 4 support
- Rename `txHash` to `txId` in `Client.getTransaction`, `TransactionData` and `EarnResult`
- Add `defaultCommitment` to `ClientConfig`
- Add optional `commitment` parameter to `Client` methods (`createAccount`, `getBalance`, `getTransaction`, `submitPayment`, `submitEarnBatch`)
- Add optional `subsidizer` parameter to `Client.create_account`, `Payment`, and `EarnBatch`
- Add optional `senderResolution` and `destinationResolution` parameters to `Client.submitPayment` and `Client.submitEarnBatch`
- Mark `tx_hash` property in `Event` as deprecated.

## [0.2.3](https://github.com/kinecosystem/kin-node/releases/tag/0.2.3)
- Add Kin 2 support

## [0.2.2](https://github.com/kinecosystem/kin-node/releases/tag/0.2.2)
- Update API version

## [0.2.1](https://github.com/kinecosystem/kin-node/releases/tag/0.2.1)
- Add user-agent metadata to Agora requests

## [0.2.0](https://github.com/kinecosystem/kin-node/releases/tag/0.2.0)
- Rename `source` in `Payment` and `EarnBatch` to `channel` for clarity
- Adjust `BadNonceError` handling

## [0.1.2](https://github.com/kinecosystem/kin-node/releases/tag/0.1.2)
- Add a `NONE` transaction type

## [0.1.1](https://github.com/kinecosystem/kin-node/releases/tag/0.1.1)
- Update installation commands

## [0.1.0](https://github.com/kinecosystem/kin-node/releases/tag/0.1.0)
- Initial release with Kin 3 support
