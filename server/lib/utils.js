
module.exports = {
    copyObject(obj) {
        return JSON.parse(JSON.stringify(obj));
    },

    sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}
