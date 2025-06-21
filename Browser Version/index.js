/**
 * Processes an XML Document object and converts it into a TypeScript Declaration File (.d.ts) string.
 * This is the main entry point for the conversion process.
 * @param {Document} xmlDocument - The XML DOM object created by the browser's DOMParser.
 * @returns {string} The generated .d.ts file content as a string.
 */
window.convertXmlDomToDts = function(xmlDocument) {
    const transformed = parse(xmlDocument);
    const sorted = sort(transformed);
    const result = generate(sorted);
    return result;
}

function directFindAll(element, selector) {
    let result = [];
    const currentSelector = selector.shift();
    if (currentSelector) {
        for (const child of Array.from(element.children)) {
            if (child.nodeName === currentSelector) {
                // Fix: Pass a copy of the selector array to avoid modification issues in recursion
                result = result.concat(directFindAll(child, selector.slice()));
            }
        }
    }
    else {
        result.push(element);
    }
    return result;
}

function directFind(element, selector) {
    const currentSelector = selector.shift();
    if (currentSelector) {
        for (const child of Array.from(element.children)) {
            if (child.nodeName === currentSelector) {
                // Fix: Pass a copy of the selector array
                const found = directFind(child, selector.slice());
                if (found) {
                    return found;
                }
            }
        }
    }
    else {
        return element;
    }
}

function parse(xmlDocument) {
    const result = [];
    // The main entry point `convertXmlDomToDts` passes the browser's `Document` object here.
    // We start searching from the document's root element.
    const definitions = directFindAll(xmlDocument.documentElement, ["package", "classdef"]);
    for (const definition of definitions) {
        result.push(parseDefinition(definition));
    }
    removeInheritedProperties(result);
    return result;
}

function parseDefinition(definition) {
    // --- IMPROVEMENT: Check for a constructor to determine class vs. interface ---
    const constructorEl = directFind(definition, ["elements", "constructor"]);
    let type;
    if (definition.getAttribute("enumeration")) {
        type = "enum";
    }
    else if (definition.getAttribute("dynamic")) {
        type = constructorEl ? "class" : "interface";
    }
    else {
        throw new Error("Unknown definition");
    }
    const props = [];
    for (const element of directFindAll(definition, ["elements"])) {
        const typeAttr = element.getAttribute("type");
        const isStatic = typeAttr === "class";
        const isConstructor = typeAttr === "constructor";
        for (const property of Array.from(element.children)) {
            // Pass isConstructor to parseProperty
            const p = parseProperty(property, isStatic, isConstructor);
            props.push(p);
        }
    }
    const extend = directFind(definition, ["superclass"]);
    return {
        type,
        name: definition.getAttribute("name") || "",
        desc: parseDesc(definition),
        extend: extend ? extend.innerHTML || undefined : undefined,
        props,
    };
}

function parseProperty(prop, isStatic, isConstructor) {
    let type;
    // --- IMPROVEMENT: Detect .index properties to create indexers ---
    if (prop.getAttribute("name") === ".index") {
        type = "indexer";
    } else if (prop.nodeName === "property") {
        type = "property";
    }
    else if (prop.nodeName === "method") {
        type = "method";
    }
    else {
        throw new Error("Unknown property " + prop.nodeName);
    }

    const p = {
        type,
        isStatic,
        readonly: prop.getAttribute("rwaccess") === "readonly",
        // Check for constructor from element type, not just name
        name: isConstructor ? "constructor" : (prop.getAttribute("name") || "").replace(/[^\[\]0-9a-zA-Z_$.]/g, "_"),
        desc: parseDesc(prop),
        params: parseParameters(directFindAll(prop, ["parameters", "parameter"])),
        types: parseType(directFind(prop, ["datatype"])),
    };
    // Standardize indexer name for the generator
    if (type === 'indexer') {
        p.name = "__indexer";
    }
    parseCanReturnAndAccept(p);
    return p;
}

function parseDesc(element) {
    let desc = [];
    const shortdesc = directFind(element, ["shortdesc"]);
    if (shortdesc && shortdesc.textContent) {
        desc.push(shortdesc.textContent);
    }
    const description = directFind(element, ["description"]);
    if (description && description.textContent) {
        desc.push(description.textContent);
    }
    desc = desc.join("\n").split("\n");
    desc = desc.map(d => d.replace(/ {2}/g, "").trim()).filter(d => d !== "");
    return desc;
}

function parseParameters(parameters) {
    const params = [];
    let previousWasOptional = false;
    // --- IMPROVEMENT: Use index to create fallback names ---
    for (const [i, parameter] of parameters.entries()) {
        const param = {
            name: parameter.getAttribute("name") || `arg${i}`,
            desc: parseDesc(parameter),
            optional: previousWasOptional || !!parameter.getAttribute("optional"),
            types: parseType(directFind(parameter, ["datatype"])),
        };
        if (param.name.includes("...")) {
            param.name = "...rest";
            param.types[0].isArray = true;
        }
        param.desc = param.desc.map(d => d.replace(/\(Optional\)/i, ""));
        parseCanReturnAndAccept(param);
        params.push(param);
        previousWasOptional = previousWasOptional || param.optional;
    }
    return params;
}

function parseCanReturnAndAccept(obj) {
    const str = obj.desc[0];
    if (!str) {
        return;
    }
    const match = str.match(/^(.*?)(?:Can(?: also)? (?:accept|return):)(.*)$/);
    if (!match || match[2].includes("containing") || match[2].match(/Arrays? of Arrays? of/)) {
        return;
    }
    match[2] = match[2].replace("Can also accept:", " or ");
    const result = parseCanReturnAndAcceptValue(match[2]);
    if (result) {
        obj.desc[0] = match[1].trim();
        obj.types = obj.types.concat(result);
        obj.types = obj.types.filter((type) => type.name !== "any");
    }
}

function parseCanReturnAndAcceptValue(str) {
    let types = [];
    const words = str.split(/,| or/);
    for (const word of words) {
        const type = {
            name: word.trim(),
            isArray: false,
        };
        if (!type.name || type.name === ".") {
            continue;
        }
        parseTypeFixTypeName(type);
        types.push(type);
    }
    types = types.filter((type, index, self) => {
        const foundIndex = self.findIndex((t) => t.name === type.name && t.isArray === type.isArray);
        return foundIndex === index;
    });
    return types;
}

function parseTypeFixTypeName(type) {
    type.name = type.name.trim();
    type.name = type.name.replace(/enumerators?/, "");
    type.name = type.name.replace(/\.$/, "");
    type.name = type.name.trim();
    if (type.name === "varies=any" || type.name === "Any") {
        type.name = "any";
    }
    else if (type.name === "Undefined") {
        type.name = "undefined";
    }
    else if (type.name === "Object") {
        type.name = "object";
    }
    else if (type.name === "String") {
        type.name = "string";
    }
    else if (type.name === "Boolean" || type.name === "bool") {
        type.name = "boolean";
    }
    else if (type.name === "Number" || type.name === "int" || type.name === "Int32" || type.name === "uint") {
        type.name = "number";
    }
    else if (type.name.match(/^(Unit|Real)\s*(\([\d.]+ - [\d.]+( points)?\))?$/)) {
        type.name = "number";
    }
    else if (type.name === "Array of 4 Units (0 - 8640 points)") {
        type.name = "[number, number, number, number]";
        type.isArray = false;
    }
    else if (type.name === "Array of Reals") {
        type.name = "number";
        type.isArray = true;
    }
    else if (type.name.match(/Arrays? of 2 Reals/)) {
        type.name = "[number, number]";
    }
    else if (type.name.match(/Arrays? of 3 Reals/)) {
        type.name = "[number, number, number]";
    }
    else if (type.name.match(/Arrays? of 6 Reals/)) {
        type.name = "[number, number, number, number, number, number]";
    }
    else if (type.name.match(/Arrays? of 2 Units/)) {
        type.name = "[number | string, number | string]";
    }
    else if (type.name.match(/Arrays? of 2 Strings/)) {
        type.name = "[string, string]";
    }
    else if (type.name.match(/(Short|Long) Integers?/)) {
        type.name = "number";
    }
    else if (type.name.startsWith("Array of ")) {
        type.name = type.name.replace(/^Array of (\S+?)s?$/, "$1").trim();
        type.isArray = true;
        parseTypeFixTypeName(type);
    }
    else if (type.name === "Swatche") {
        type.name = "Swatch";
    }
    else if (type.name === "JavaScript Function") {
        type.name = "Function";
    }
}

function parseType(datatype) {
    const types = [];
    if (datatype) {
        const typeElement = directFind(datatype, ["type"]);
        const valueElement = directFind(datatype, ["value"]);
        const type = {
            name: typeElement ? typeElement.textContent || "" : "",
            isArray: !!directFind(datatype, ["array"]),
            value: valueElement ? valueElement.textContent || "" : undefined,
        };
        if (type.name === "Measurement Unit (Number or String)=any") {
            type.name = "number | string";
            if (type.isArray) {
                type.name = "(" + type.name + ")";
            }
        }
        parseTypeFixTypeName(type);
        types.push(type);
    }
    else {
        types.push({
            name: "void",
            isArray: false,
        });
    }
    return types;
}

function removeInheritedProperties(definitions) {
    for (const definition of definitions) {
        const props = getListOfPropsToBeRemovedFor(definition, definitions);
        for (const prop of props) {
            definition.props = definition.props.filter(p => p.name !== prop);
        }
    }
}

function getListOfPropsToBeRemovedFor(definition, definitions) {
    let props = [];
    if (definition.extend) {
        const parent = definitions.find(d => d.name === definition.extend);
        if (parent) {
            for (const prop of parent.props) {
                props.push(prop.name);
            }
            const p = getListOfPropsToBeRemovedFor(parent, definitions);
            props = props.concat(p);
        }
    }
    return props;
}

function sort(definitions) {
    definitions.sort((a, b) => {
        if (a.name < b.name) {
            return -1;
        }
        else if (a.name > b.name) {
            return 1;
        }
        else {
            return 0;
        }
    });
    for (const definition of definitions) {
        definition.props.sort((a, b) => {
            // Keep properties and indexers before methods
            if (a.type !== b.type) {
                if(a.type === 'method') return 1;
                if(b.type === 'method') return -1;
            }
            // Then sort alphabetically
            if (a.name < b.name) {
                return -1;
            }
            else if (a.name > b.name) {
                return 1;
            }
            else {
                return 0;
            }
        });
    }
    return definitions;
}

/** --- IMPROVEMENT: Rewritten to support namespaces --- */
function generate(definitions) {
    const namespaces = {};
    const rootDefinitions = [];

    // Group definitions by namespace or add to root
    for (const def of definitions) {
        if (def.name.includes('.')) {
            const parts = def.name.split('.');
            const ns = parts[0];
            const className = parts.slice(1).join('.');
            if (!namespaces[ns]) {
                namespaces[ns] = [];
            }
            // Create a new definition object with the updated name for the namespace
            const newDef = Object.assign({}, def, { name: className });
            namespaces[ns].push(newDef);
        } else {
            rootDefinitions.push(def);
        }
    }

    let output = "";

    // Generate root-level definitions first
    for (const definition of rootDefinitions) {
        output += generateDefinition(definition);
    }
    
    // Then generate namespaced definitions
    for (const nsName in namespaces) {
        output += "declare namespace " + nsName + " {\n";
        for (const definition of namespaces[nsName]) {
            output += generateDefinition(definition, "\t");
        }
        output += "}\n\n";
    }

    return output;
}

/** --- IMPROVEMENT: Extracted definition generation into a helper function --- */
function generateDefinition(definition, indent = "") {
    let output = "";
    output += indent + "/**\n" + indent + " * " + definition.desc.join("\n" + indent + " * ") + "\n" + indent + " */\n";
    const name = "declare " + definition.type + " " + definition.name;
    const extend = definition.extend ? " extends " + definition.extend : "";
    output += indent + name + extend + " {\n";
    
    for (const prop of definition.props) {
        const propIndent = indent + "\t";
        output += propIndent + "/**\n" + propIndent + " * " + prop.desc.join("\n" + propIndent + " * ") + "\n";
        
        // --- IMPROVEMENT: Handle indexer, constructor, and method generation ---
        if (prop.type === "method" || prop.type === "indexer") {
            const params = prop.params.map(param => {
                const methodName = generateFixParamName(param.name);
                const desc = param.desc.join(" ").trim();
                if (desc) {
                    output += propIndent + " * @param " + methodName + " " + desc + "\n";
                }
                return methodName + (param.optional ? "?" : "") + ": " + generateType(param.types);
            });
            output += propIndent + " */\n";
            const type = generateType(prop.types);
            const staticKeyword = (prop.isStatic ? "static " : "");
            const readonlyKeyword = (prop.readonly ? "readonly " : "");

            if (prop.type === "indexer") {
                output += propIndent + readonlyKeyword + "[" + params.join(", ") + "]: " + type + ";\n";
            } else if (prop.name === "constructor") {
                output += propIndent + "constructor(" + params.join(", ") + ");\n";
            } else {
                output += propIndent + staticKeyword + prop.name + "(" + params.join(", ") + "): " + type + ";\n";
            }
        }
        else if (definition.type === "class" || definition.type === "interface") {
            output += propIndent + " */\n";
            const className = prop.name === "constructor" ? "'constructor'" : prop.name;
            const staticKeyword = (prop.isStatic ? "static " : "");
            const readonlyKeyword = (prop.readonly ? "readonly " : "");
            const type = generateType(prop.types);
            output += propIndent + staticKeyword + readonlyKeyword + className + ": " + type + ";\n";
        }
        else if (definition.type === "enum") {
            output += propIndent + " */\n";
            output += propIndent + prop.name + " = " + prop.types[0].value + ",\n";
        }
        output += "\n";
    }
    output += indent + "}\n\n";
    return output;
}

function generateType(types) {
    const output = [];
    for (const type of types) {
        output.push(type.name + (type.isArray ? "[]" : ""));
    }
    return output.join(" | ");
}

function generateFixParamName(name) {
    if (name === "for") {
        return "for_";
    }
    else if (name === "with") {
        return "with_";
    }
    else if (name === "in") {
        return "in_";
    }
    else if (name === "default") {
        return "default_";
    }
    else if (name === "return") {
        return "return_";
    }
    else if (name === "export") {
        return "export_";
    }
    else if (name === "function") {
        return "function_";
    }
    return name;
}
