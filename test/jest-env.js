// Addresses this issue: https://github.com/facebook/jest/issues/4422
// Custom environment stolen from: https://github.com/facebook/jest/issues/7780#issuecomment-615890410
"use strict";

const NodeEnvironment = require("jest-environment-node");

class MyEnvironment extends NodeEnvironment {
  constructor(config) {
    super(
      Object.assign({}, config, {
        globals: Object.assign({}, config.globals, {
          Uint32Array: Uint32Array,
          Uint8Array: Uint8Array,
          ArrayBuffer: ArrayBuffer,
        }),
      }),
    );
  }

  async setup() {}

  async teardown() {}

}

module.exports = MyEnvironment;
