import { MemoParams, MemoInstruction, MemoProgram, } from "../../src/solana/memo-program"

test('TestMemoProgram', () => {
    const params: MemoParams = {
        data: 'somedata',
    }
    const instruction = MemoProgram.memo(params)
    expect(params).toEqual(
        MemoInstruction.decodeMemo(instruction)
    )
})
