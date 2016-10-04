#!env node

const numFeatures = Number(process.argv[2]);

if (isNaN(numFeatures)) {
  console.log(`Usage: node ${process.argv[1]} <numFeatures>`);
  process.exit(1);
}

const fs = require('fs');
const fd = fs.openSync('./fake-earthquakes.geojson', 'w');

function write(string) {
  fs.writeSync(fd, string);
}

write(`{
  "type": "FeatureCollection",
  "features": [
`)


for (let i = 0; i < numFeatures; i++) {
  let str = i ? ',\n    ' : '    ';

  str += JSON.stringify({
    type: 'Feature',
    properties: {
      magnitude: Math.round(800 * Math.random() + 100) / 100
    },
    geometry: {
      type: 'Point',
      coordinates: [
        360 * Math.random() - 180,
        180 * Math.random() - 90
      ]
    }
  });

  write(str);
}

write(`
  ]
}`);

fs.closeSync(fd);
