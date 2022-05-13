const aggregate = require("./aggregate");
const gen = require("./gen");

(async function() {
    if (process.argv[2] === "aggregate") {
        await aggregate(process.argv[3], process.argv.slice(4));
    } else {
        await gen(process.argv[2], process.argv[3], process.argv[4]);
    }
})();
