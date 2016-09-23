'use strict';

var util = require('../util/util');
var ajax = require('../util/ajax');
var rewind = require('geojson-rewind');
var GeoJSONWrapper = require('./geojson_wrapper');
var vtpbf = require('vt-pbf');
var supercluster = require('supercluster');
var geojsonvt = require('geojson-vt');

var VectorTileWorkerSource = require('./vector_tile_worker_source');

module.exports = GeoJSONWorkerSource;

/**
 * The {@link WorkerSource} implementation that supports {@link GeoJSONSource}.
 * This class is designed to be easily reused to support custom source types
 * for data formats that can be parsed/converted into an in-memory GeoJSON
 * representation.  To do so, create it with
 * `new GeoJSONWorkerSource(actor, styleLayers, customLoadGeoJSONFunction)`.  For a full example, see [mapbox-gl-topojson](https://github.com/developmentseed/mapbox-gl-topojson).
 *
 * @class GeoJSONWorkerSource
 * @private
 * @param {Function} [loadGeoJSON] Optional method for custom loading/parsing of GeoJSON based on parameters passed from the main-thread Source.  See {@link GeoJSONWorkerSource#loadGeoJSON}.
 */
function GeoJSONWorkerSource (actor, styleLayers, loadGeoJSON) {
    if (loadGeoJSON) { this.loadGeoJSON = loadGeoJSON; }
    VectorTileWorkerSource.call(this, actor, styleLayers);
}

GeoJSONWorkerSource.prototype = util.inherit(VectorTileWorkerSource, /** @lends GeoJSONWorkerSource.prototype */ {
    // object mapping source ids to geojson-vt-like tile indexes
    _geoJSONIndexes: {},

    /**
     * See {@link VectorTileWorkerSource#loadTile}.
     */
    loadVectorData: function (params, callback) {
        var source = params.source,
            coord = params.coord;

        if (!this._geoJSONIndexes[source]) {
            return callback(null, null);  // we couldn't load the file
        }

        var geoJSONTile = this._geoJSONIndexes[source].getTile(Math.min(coord.z, params.maxZoom), coord.x, coord.y);
        if (!geoJSONTile) {
            return callback(null, null); // nothing in the given tile
        }

        var geojsonWrapper = new GeoJSONWrapper(geoJSONTile.features);
        geojsonWrapper.name = '_geojsonTileLayer';
        var pbf = vtpbf({ layers: { '_geojsonTileLayer': geojsonWrapper }});
        if (pbf.byteOffset !== 0 || pbf.byteLength !== pbf.buffer.byteLength) {
            // Compatibility with node Buffer (https://github.com/mapbox/pbf/issues/35)
            pbf = new Uint8Array(pbf);
        }
        geojsonWrapper.rawData = pbf.buffer;
        callback(null, geojsonWrapper);
    },

    /**
     * Fetches (if appropriate), parses, and index geojson data into tiles. This
     * preparatory method must be called before {@link GeoJSONWorkerSource#loadTile}
     * can correctly serve up tiles.
     *
     * Defers to {@link GeoJSONWorkerSource#loadGeoJSON} for the fetching/parsing,
     * expecting `callback(error, data)` to be called with either an error or a
     * parsed GeoJSON object.
     * @param {object} params
     * @param {string} params.source The id of the source.
     * @param {Function} callback
     */
    loadData: function (params, callback) {
        var handleData = function(err, data) {
            if (err) return callback(err);
            if (typeof data != 'object') {
                return callback(new Error("Input data is not a valid GeoJSON object."));
            }
            rewind(data, true);
            this._indexData(data, params, function (err, indexed) {
                if (err) { return callback(err); }
                this._geoJSONIndexes[params.source] = indexed;
                callback(null);
            }.bind(this));
        }.bind(this);

        this.loadGeoJSON(params, handleData);
    },

    /**
     * Fetch and parse GeoJSON according to the given params.  Calls `callback`
     * with `(err, data)`, where `data` is a parsed GeoJSON object.
     *
     * GeoJSON is loaded and parsed from `params.url` if it exists, or else
     * expected as a literal (string or object) `params.data`.
     *
     * @param {object} params
     * @param {string} [params.url] A URL to the remote GeoJSON data.
     * @param {object} [params.data] Literal GeoJSON data. Must be provided if `params.url` is not.
     */
    loadGeoJSON: function (params, callback) {
        // Because of same origin issues, urls must either include an explicit
        // origin or absolute path.
        // ie: /foo/bar.json or http://example.com/bar.json
        // but not ../foo/bar.json
        if (params.url) {
            ajax.getJSON(params.url, callback);
        } else if (typeof params.data === 'string') {
            try {
                return callback(null, JSON.parse(params.data));
            } catch (e) {
                return callback(new Error("Input data is not a valid GeoJSON object."));
            }
        } else {
            return callback(new Error("Input data is not a valid GeoJSON object."));
        }
    },

    /**
     * Index the data using either geojson-vt or supercluster
     * @param {GeoJSON} data
     * @param {object} params forwarded from loadTile.
     * @param {callback} (err, indexedData)
     * @private
     */
    _indexData: function (data, params, callback) {
        try {
            if (params.cluster) {
                callback(null, supercluster(this._getSuperclusterOptions(params)).load(data.features));
            } else {
                callback(null, geojsonvt(data, params.geojsonVtOptions));
            }
        } catch (err) {
            return callback(err);
        }
    },

    // index of possible custom aggregate functions for supercluster
    _superclusterAggregateFunctions: {
        sum: function (a, b) { return (Number(a) || 0) + (Number(b) || 0); },
        min: function (a, b) {
            return Math.min(Number(a) || Infinity, Number(b) || Infinity);
        },
        max: function (a, b) {
            return Math.max(Number(a) || -Infinity, Number(b) || -Infinity);
        },
        min_string: function (a, b) { return a < b ? a : b; },
        max_string: function (a, b) { return a > b ? a : b; },
        and: function (a, b) { return a && b; },
        or: function (a, b) { return a || b; }
    },

    /**
     * Accumulate properties within a cluster
     * @param {object} aggregates keys define the property name and value defines the aggregate type
     * @param {object} pointProperties properties from a single point
     * @param {object} neighborProperties properties from the neighboring point or cluster
     * @private
     */
    _superclusterAccumulator: function(aggregates, point, neighbor) {
        var newProperties = {};

        for (var destProperty in aggregates) {
            var aggType = aggregates[destProperty][0];
            var srcProperty = aggregates[destProperty][1];

            newProperties[destProperty] = this._superclusterAggregateFunctions[aggType](
                point.properties[point.numPoints > 1 ? destProperty : srcProperty],
                neighbor.properties[neighbor.numPoints > 1 ? destProperty : srcProperty]
            );
        }

        return newProperties;
    },

    /**
     * Modify supercluster options to include custom aggregators
     * @param {object} params forwarded from loadTile.
     * @private
     */
    _getSuperclusterOptions: function (params) {
        var options = util.extend({}, params.superclusterOptions);
        var aggregates = options.aggregates;

        if (aggregates) {
            options.accumulator = this._superclusterAccumulator.bind(this, aggregates);
            delete options.aggregates;
        }

        return options;
    }
});
