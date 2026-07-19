function greet(name) {
    return `Hello ${name}, welcome to the BL Series backend!`;
}

function getProjectInfo() {
    return {
        name: "BL Series Website",
        version: "1.0.0",
        author: "Jimboy"
    };
}

function BLSeries() {
    return {
        seriesName: "The Untamed",
        genre: "Romance, Drama",
        country: "China",
    }
}

function favoriteBLSeries(series) {
    return `My favorite BL series is ${series}.`;
}

module.exports = {greet, getProjectInfo, BLSeries, favoriteBLSeries };