const gen = require("./gen");
const fs = require("fs").promises;

(async function() {
    await gen("matrix-org", "matrix-js-sdk", "element-web");
    await gen("matrix-org", "matrix-js-sdk", "Design");
    await gen("matrix-org", "matrix-js-sdk", "Product");

    await gen("matrix-org", "matrix-react-sdk", "element-web");
    await gen("matrix-org", "matrix-react-sdk", "Design");
    await gen("matrix-org", "matrix-react-sdk", "Product");

    await gen("vector-im", "element-web", "element-web");
    await gen("vector-im", "element-web", "Design");
    await gen("vector-im", "element-web", "Product");

    console.log("Actually done");
})();
