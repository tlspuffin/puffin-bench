/**
 * JSON serialisation helpers for Map and Set.
 * JSON.stringify/parse do not support Map or Set natively.
 * This class encodes them as { __type: 'Map'|'Set', value: [...] }
 * so they survive a round-trip through JSON.
 *
 * Note: the __type key is a reserved marker — avoid using it in your own data objects.
 */
class JSONHelp {

  /**
   * Serialises an object (possibly containing Map/Set values) to a JSON string.
   * @param {*} object
   * @param {string|number} [space] - Indentation passed to JSON.stringify (e.g. 2 for multiline output)
   * @returns {string}
   */
  static Stringify(object, space) {
    return JSON.stringify(object, this.#Replacer, space);
  }

  /**
   * Deserialises a JSON string, restoring any encoded Map or Set values.
   * @param {string} jsontext
   * @returns {*}
   */
  static Parse(jsontext) {
    return JSON.parse(jsontext, this.#Reviver);
  }

  static #Replacer(key, value) {
    // Shrink saved files: omit null-valued object properties. Readers default any
    // absent key to null (?? null / optional chaining). In an array the returned
    // undefined is serialized by JSON.stringify as null, so Map entries encoded as
    // [key, null] (e.g. metric variables) keep their key and null value.
    if (value === null) return undefined;
    if (value instanceof Map) {
      return { __type: 'Map', value: Array.from(value.entries())};
    }
    if (value instanceof Set) {
      return { __type: 'Set', value: Array.from(value)};
    }
    if (typeof value === 'object' && value !== null
        && 'variable' in value && Object.keys(value).length === 1) {
      return { __type: 'MetricVarRef', value: value.variable };
    }
    return value;
  };

  static #Reviver(key, value) {
    if (typeof value === 'object' && value !== null) {
      if (value.__type === 'Map') {
        return new Map(value.value);
      }
      if (value.__type === 'Set') {
        return new Set(value.value);
      }
      if (value.__type === 'MetricVarRef') {
        return { variable: value.value };
      }
    }
    return value;
  };
};

export { JSONHelp };