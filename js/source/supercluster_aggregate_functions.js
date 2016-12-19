'use strict';

function toNumber(input, defaultValue) {
    let num = new Number(input);
    return isNaN(input) ? defaultValue : num;
}

// index of possible custom aggregate functions for supercluster
module.exports = {
    sum(a, b) { return toNumber(a, 0) + toNumber(b, 0); },
    min(a, b) {
        return Math.min(toNumber(a, Infinity), toNumber(b, Infinity));
    },
    max(a, b) {
        return Math.max(toNumber(a, -Infinity), toNumber(b, -Infinity));
    },
    min_string(a, b) { return a < b ? a : b; },
    max_string(a, b) { return a > b ? a : b; },
    and(a, b) { return a && b; },
    or(a, b) { return a || b; }
};
