class JSONHelp {

  static Stringify(object) {
    return JSON.stringify(object, this.#Replacer);
  }

  static Parse(jsontext) {
    return JSON.parse(jsontext, this.#Reviver);
  }

  static #Replacer(key, value) {
    if (value instanceof Map) {
      return { __type: 'Map', value: Array.from(value.entries())};
    }
    if (value instanceof Set) {
      return { __type: 'Set', value: Array.from(value)};
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
    }
    return value;
  };
};

export { JSONHelp };