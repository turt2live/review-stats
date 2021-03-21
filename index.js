const gen = require("./gen");

(async function() {
    await gen(process.argv[2], process.argv[3], process.argv[4]);
})();
