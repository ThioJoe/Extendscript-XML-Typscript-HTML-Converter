/**
 * Main Entry Point
 * PRIME DIRECTIVE: Parse Adobe ExtendScript XML DOM files (which are malformed from the source) 
 * and recover correct type definitions by cross-referencing with binary DLL files.
 * * @param {Document} xmlDocument - The XML DOM object containing the malformed ExtendScript definitions.
 * @param {Array<{name: string, data: Uint8Array}>} dllBuffers - Optional binary data from DLLs used for recovery.
 * @returns {string} - The generated TypeScript definition (.d.ts) content.
 */
// @ts-ignore - Intentionally extending window object for browser context
window.convertXmlDomToDts = function (xmlDocument, dllBuffers = []) {
    // 1. Parse XML to AST
    const definitions = parse(xmlDocument);

    // 2. Fix using DLL binaries if provided
    if (dllBuffers && dllBuffers.length > 0) {
        refineDefinitionsWithDlls(definitions, dllBuffers);
    }

    // 3. Sort and Generate
    // Note: These functions handle final output formatting (not shown in this snippet)
    const sorted = sort(definitions);
    return generate(sorted);
}

// Configuration Constants
/** Prefix used for placeholder parameter names when XML name is invalid (e.g., uArg1, uArg2) */
const UNNAMED_ARG_PREFIX = "uArg";

// #region Typedefs
/**
 * @typedef {Object} StringIndexEntry
 * @property {string} text - The extracted string
 * @property {number} startIndex - Byte position in buffer
 * @property {number} stringIndex - Index in allStrings array
 */

/**
 * @typedef {Object} TypeInfo
 * @property {string} name - The TypeScript type name
 * @property {boolean} isArray - Whether this is an array type
 * @property {string} [value] - Optional value for enum members
 */

/**
 * @typedef {Object} Parameter
 * @property {string} name - Parameter name
 * @property {Array<string>} desc - Parameter description lines
 * @property {boolean} optional - Whether parameter is optional
 * @property {Array<TypeInfo>} types - Parameter type information
 * @property {boolean} [_malformed] - Internal flag indicating XML corruption
 * @property {boolean} [_descFromXml] - Internal flag: true if desc came from XML shortdesc tag, false if from invalid param name
 * @property {boolean} [_wasSpaceName] - Internal flag: true if this arg# came from converting a space-named param (legitimate)
 * @property {number} [_xmlDescCount] - Internal flag: count of descriptions from XML (before type-derived ones added)
 */

/**
 * @typedef {Object} Property
 * @property {string} type - Property type: 'method', 'property', or 'indexer'
 * @property {boolean} isStatic - Whether this is a static member
 * @property {boolean} readonly - Whether this is readonly
 * @property {string} name - Property/method name
 * @property {Array<string>} desc - Description lines
 * @property {Array<Parameter>} params - Method parameters (for methods)
 * @property {Array<TypeInfo>} types - Return/property type information
 * @property {boolean} [_needsFullBinaryRecovery] - Internal flag for DLL recovery
 * @property {boolean} [_hasParamsToEnrich] - Internal flag for param enrichment
 */

/**
 * @typedef {Object} Definition
 * @property {string} type - Definition type: 'class', 'interface', or 'enum'
 * @property {string} name - Class/interface/enum name
 * @property {Array<string>} desc - Description lines
 * @property {string} [extend] - Parent class name (if extends)
 * @property {Array<Property>} props - Properties and methods
 */

/**
 * @typedef {Object} ParamMatch
 * @property {string} name - Parameter name extracted from binary
 * @property {string} desc - Parameter description extracted from binary
 * @property {number} position - Position index: >=0 for immediate vicinity, -1 for class cache, -2 for global cache
 */

/**
 * Binary method information extracted from DLL.
 * @typedef {Object} BinaryMethodInfo
 * @property {Array<ParamMatch>} paramMatches - Array of parameter matches found in binary.
 * @property {string|null} methodDesc - Method description found in binary.
 * @property {number} binaryParamCount - Number of real parameters found in binary.
 * @property {boolean} hasCommaSplitCorruption - True if XML params appear to be corrupted by comma splits.
 */

// #region Binary Parsing
// ==========================================
// BINARY DLL PARSING & RECOVERY
// ==========================================

/**
 * Pre-index all null-terminated strings in a DLL buffer.
 * Returns a Map for O(1) method name lookups and an ordered array for index-based access to preceding strings.
 * * PERFORMANCE NOTE: This was optimized from O(n) per method to O(1).
 * User reported the previous linear scan was too slow. This function scans the binary once
 * and builds a lookup table.
 * * @param {Uint8Array} buffer - The binary content of the DLL.
 * @returns {{stringMap: Map<string, Array<StringIndexEntry>>, allStrings: Array<StringIndexEntry>}}
 */
function buildStringIndex(buffer) {
    const textDecoder = new TextDecoder('utf-8');
    const stringMap = new Map(); // string -> [{text, startIndex, stringIndex}]
    const allStrings = []; // Array of {text, startIndex, stringIndex}

    let i = 0;
    const len = buffer.length;

    while (i < len) {
        // Skip nulls to find start of string
        while (i < len && buffer[i] === 0) i++;
        if (i >= len) break;

        const startIndex = i;

        // Find end of string (next null or end of buffer)
        while (i < len && buffer[i] !== 0) i++;

        const endIndex = i;

        // Only process reasonable-length strings (skip garbage)
        const strLen = endIndex - startIndex;
        if (strLen > 0 && strLen < 500) {
            try {
                // Use subarray instead of slice to avoid copying large chunks of memory
                const text = textDecoder.decode(buffer.subarray(startIndex, endIndex));

                // Only index strings that look like valid identifiers or descriptions
                // This filters out binary noise which reduces map size and lookup collisions
                if (isValidString(text)) {
                    /** @type {StringIndexEntry} */
                    const entry = { text, startIndex, stringIndex: allStrings.length };
                    allStrings.push(entry);

                    if (!stringMap.has(text)) {
                        stringMap.set(text, []);
                    }
                    stringMap.get(text).push(entry);
                }
            } catch (e) {
                // Invalid UTF-8, skip
            }
        }
    }

    return { stringMap, allStrings };
}

/** * Quick check if string is likely valid text (not binary garbage).
 * Used to filter out random binary sequences that happen to not contain null bytes.
 * * @param {string} str 
 * @returns {boolean}
 */
function isValidString(str) {
    if (str.length === 0) return false;
    // Count printable ASCII + common extended chars
    let printable = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        // Allow standard ASCII, tab, newline, return, and extended ASCII
        if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13 || c > 160) {
            printable++;
        }
    }
    return printable / str.length > 0.8; // At least 80% printable to be considered text
}

/**
 * Build a GLOBAL cache of all parameter descriptions in the entire DLL.
 * This allows finding parameter descriptions that are reused across classes.
 * Used as a last-resort fallback after checking immediate vicinity and class cache.
 * * @param {Array<StringIndexEntry>} allStrings - All indexed strings from DLL
 * @returns {Map<string, string>} - Map of paramName -> description
 */
function buildGlobalParameterCache(allStrings) {
    /** @type {Map<string, string>} */
    const cache = new Map();
    /** @type {Map<string, Array<string>>} */
    const duplicates = new Map(); // Track all descriptions for each param name
    
    let debugInterpolationType = false; // Set to true to debug specific param
    
    for (let i = 0; i < allStrings.length; i++) {
        const rawString = allStrings[i].text;
        
        // DEBUG: Check if this string contains our target param
        if (rawString.toLowerCase().includes('interpolationtype')) {
            console.log(`[CACHE BUILD DEBUG] Found string with 'interpolationtype': "${rawString.substring(0, 150)}"`);
            debugInterpolationType = true;
        }
        
        // Check for "paramName: description" pattern
        const colonIndex = rawString.indexOf(':');
        const textBeforeColon = colonIndex !== -1 ? rawString.substring(0, colonIndex).trim() : '';
        
        const hasColonInReasonablePosition = colonIndex !== -1 && colonIndex < 50;
        const hasValidIdentifierBeforeColon = textBeforeColon.length > 0 && !textBeforeColon.includes(' ');
        const hasColonPattern = hasColonInReasonablePosition && hasValidIdentifierBeforeColon;
        
        if (debugInterpolationType) {
            console.log(`[CACHE BUILD DEBUG] colonIndex=${colonIndex}, textBeforeColon="${textBeforeColon}", hasColonInReasonablePosition=${hasColonInReasonablePosition}, hasValidIdentifierBeforeColon=${hasValidIdentifierBeforeColon}, hasColonPattern=${hasColonPattern}`);
            debugInterpolationType = false;
        }
        
        if (hasColonPattern) {
            const paramName = textBeforeColon;
            const paramDesc = rawString.substring(colonIndex + 1).trim();
            
            // Track duplicates for debugging
            if (!duplicates.has(paramName)) {
                duplicates.set(paramName, []);
            }
            const dupArray = duplicates.get(paramName);
            if (dupArray) {
                dupArray.push(paramDesc);
            }
            
            // Store in cache - prefer LONGER descriptions when there are duplicates
            if (!cache.has(paramName)) {
                cache.set(paramName, paramDesc);
            } else {
                // If we find a longer description, use that instead
                const existingDesc = cache.get(paramName);
                if (existingDesc && paramDesc.length > existingDesc.length) {
                    console.log(`[CACHE] Found longer description for "${paramName}": ${existingDesc.length} chars -> ${paramDesc.length} chars`);
                    cache.set(paramName, paramDesc);
                }
            }
        }
    }
    
    // Log parameters with multiple different descriptions
    for (const [paramName, descriptions] of duplicates.entries()) {
        if (descriptions.length > 1) {
            const uniqueDescs = [...new Set(descriptions)];
            if (uniqueDescs.length > 1) {
                console.log(`[CACHE WARNING] Parameter "${paramName}" has ${uniqueDescs.length} different descriptions in binary (keeping longest):`);
                for (const desc of uniqueDescs) {
                    console.log(`  - [${desc.length} chars] ${desc.substring(0, 80)}${desc.length > 80 ? '...' : ''}`);
                }
            }
        }
    }
    
    console.log(`[CACHE BUILD] Built global cache with ${cache.size} parameter descriptions`);
    return cache;
}

/**
 * REMOVED - Class cache was too limited by search radius.
 * Now we just use the global cache for everything since parameters can be anywhere in the DLL.
 * This function is kept for backwards compatibility but just returns the global cache.
 * * @param {Map<string, string>} globalCache - The global parameter cache
 * @returns {Map<string, string>} - The same global cache (no longer class-scoped)
 */
function buildClassParameterCache(globalCache) {
    // Just return the global cache - no point in limiting by radius
    return globalCache;
}

/**
 * Iterates through parsed definitions and enriches them using binary data.
 * This is the core "Correction" phase.
 * * @param {Array<Definition>} definitions - The AST parsed from XML.
 * @param {Array<{name: string, data: Uint8Array}>} dllBuffers - Binary DLL data.
 */
function refineDefinitionsWithDlls(definitions, dllBuffers) {
    // Pre-index all DLLs once (the big optimization!)
    const indexedDlls = dllBuffers.map(dll => {
        const stringIndex = buildStringIndex(dll.data);
        return {
            name: dll.name,
            data: dll.data,
            stringMap: stringIndex.stringMap,
            allStrings: stringIndex.allStrings,
            globalParamCache: buildGlobalParameterCache(stringIndex.allStrings)
        };
    });
    
    // Merge all DLL parameter caches into one master cache
    // Parameters can be defined in one DLL but used in methods in another DLL
    /** @type {Map<string, string>} */
    const masterParamCache = new Map();
    for (const dll of indexedDlls) {
        for (const [paramName, paramDesc] of dll.globalParamCache.entries()) {
            // First occurrence wins (they should be identical across DLLs)
            if (!masterParamCache.has(paramName)) {
                masterParamCache.set(paramName, paramDesc);
            }
        }
    }
    console.log(`[MASTER CACHE] Merged ${indexedDlls.length} DLLs into master cache with ${masterParamCache.size} total parameter descriptions`);

    for (const def of definitions) {
        for (const prop of def.props) {
            // Class properties seem to be unaffected so we will focus only on methods and their parameters
            if (prop.type !== 'method') continue;

            // Optimization: Skip if no params and not malformed - nothing to recover
            // EDIT: We won't skip immediately yet
            // if (!prop._needsFullBinaryRecovery && !prop._hasParamsToEnrich) continue;

            // O(1) lookup instead of O(n) scan via the map built in buildStringIndex
            for (const dll of indexedDlls) {
                const matches = dll.stringMap.get(prop.name);
                if (!matches || matches.length === 0) continue;

                // Use first match (they should be identical for our purposes)
                const match = matches[0];

                // Use global parameter cache directly - no artificial radius limits
                const classParamCache = dll.globalParamCache;

                // Get preceding strings directly from pre-indexed array.
                // Binary layout is: [desc] [paramN] ... [param1] [methodName]
                const foundStrings = [];
                const maxPrecedingStrings = prop.params.length + 2; // Look back enough for params + desc

                for (let k = 1; k <= maxPrecedingStrings; k++) {
                    const precedingIdx = match.stringIndex - k;
                    if (precedingIdx < 0) break;

                    const precedingEntry = dll.allStrings[precedingIdx];

                    // Sanity check: don't look back more than 500 bytes (locality principle)
                    if (match.startIndex - precedingEntry.startIndex > 500) break;

                    // Filter out known garbage like Adobe's internal variable markers
                    if (!precedingEntry.text.startsWith("$$$")) {
                        foundStrings.push(precedingEntry.text);
                    }
                }

                if (foundStrings.length > 0) {
                    // STAGE 1: Extract information from binary (with master cache containing ALL DLLs)
                    /** @type {BinaryMethodInfo} */
                    const binaryInfo = extractBinaryMethodInfo(foundStrings, masterParamCache, masterParamCache, prop.params);
                    
                    // STAGE 2: Decide what needs fixing and apply
                    applyBinaryFixesToMethod(prop, binaryInfo);
                }
                break; // Stop searching DLLs for this method once found in one
            }
        }
    }
}

/**
 * STAGE 1: Extract and parse information from binary strings.
 * Does NOT modify the property object - only collects data.
 * * BINARY STRUCTURE TRUTH:
 * [method desc] [NULLS] [paramN: desc] [NULLS] ... [NULLS] [param1: desc] [NULLS] methodName
 * * PRIORITY SYSTEM:
 * 1. Immediate vicinity (foundStrings) - highest priority
 * 2. Class-level cache (within ~100 strings of method)
 * 3. Global DLL cache (entire binary) - fallback for unmatched placeholders only
 * * @param {Array<string>} foundStrings - Strings found preceding the method name in binary.
 * @param {Map<string, string>} classParamCache - Class-level cache of param descriptions
 * @param {Map<string, string>} globalParamCache - Global DLL cache (entire binary)
 * @param {Array<Parameter>} xmlParams - Parameters from XML (for cross-referencing)
 * @returns {BinaryMethodInfo} - Extracted parameter and method description information.
 */
function extractBinaryMethodInfo(foundStrings, classParamCache, globalParamCache, xmlParams) {
    // foundStrings[0] = string immediately LEFT of method name (param1)
    // foundStrings[1] = string two positions left (param2), etc.

    /** @type {Array<ParamMatch>} */
    const paramMatches = [];
    let lastColonPatternIndex = -1;
    /** @type {string|null} */
    let methodDesc = null;

    // Scan all strings for "paramName: description" patterns
    for (let i = 0; i < foundStrings.length; i++) {
        const rawString = foundStrings[i];

        // Check for "Name: Description" pattern (TRUTH: This is the reliable pattern from binary)
        const colonIndex = rawString.indexOf(':');
        const textBeforeColon = colonIndex !== -1 ? rawString.substring(0, colonIndex).trim() : '';
        
        // Rule: Valid parameter pattern requires colon within first 50 chars
        const hasColonInReasonablePosition = colonIndex !== -1 && colonIndex < 50;
        
        // Rule: Name before colon must be non-empty and single identifier (no spaces)
        const hasValidIdentifierBeforeColon = textBeforeColon.length > 0 && !textBeforeColon.includes(' ');
        
        // Combined rule: This is a valid "paramName: description" pattern
        const hasColonPattern = hasColonInReasonablePosition && hasValidIdentifierBeforeColon;

        if (hasColonPattern) {
            lastColonPatternIndex = i;
            const extractedName = textBeforeColon;
            const extractedDesc = rawString.substring(colonIndex + 1).trim();
            
            /** @type {ParamMatch} */
            const match = {
                name: extractedName,
                desc: extractedDesc,
                position: i
            };
            paramMatches.push(match);
        }
    }

    // Look for method description immediately after the last colon pattern
    // TRUTH: The method description is always the string immediately preceding the last parameter definition in binary
    // (In our reversed foundStrings array, that means index + 1)
    if (lastColonPatternIndex >= 0 && lastColonPatternIndex + 1 < foundStrings.length) {
        const methodDescCandidate = foundStrings[lastColonPatternIndex + 1].trim();

        // Rule: Method description must be substantial (not just a short fragment)
        const hasSubstantialLength = methodDescCandidate.length > 15;
        
        // Rule: Must contain spaces (descriptions are sentences, not single words)
        const containsSpaces = methodDescCandidate.includes(' ');
        
        // Rule: Filter out known garbage patterns
        const isNotGarbagePattern = !methodDescCandidate.endsWith(" class");
        
        // Combined rule: This is a valid method description
        const isValidMethodDesc = hasSubstantialLength && containsSpaces && isNotGarbagePattern;

        if (isValidMethodDesc) {
            methodDesc = methodDescCandidate;
        }
    }

    // ENRICHMENT PHASE 1: Check class cache for any XML params we haven't found yet
    // This handles parameters whose descriptions appear elsewhere in the class (shared params)
    const matchedParamNames = new Set(paramMatches.map(m => m.name));
    
    for (const xmlParam of xmlParams) {
        // Skip if we already matched this param from immediate vicinity
        if (matchedParamNames.has(xmlParam.name)) continue;
        
        // Skip placeholder names (arg#/uArg#) and invalid names for CLASS cache
        // (We'll check placeholders against global cache in next phase)
        const placeholderPattern = new RegExp(`^(arg|${UNNAMED_ARG_PREFIX})\\d+$`);
        const isPlaceholder = xmlParam.name.match(placeholderPattern);
        const isInvalidName = xmlParam.name.includes(' ') || xmlParam.name.match(/^\d/);
        if (isPlaceholder || isInvalidName) continue;
        
        // Check if this param name exists in class cache
        const cachedDesc = classParamCache.get(xmlParam.name);
        if (cachedDesc) {
            /** @type {ParamMatch} */
            const cacheMatch = {
                name: xmlParam.name,
                desc: cachedDesc,
                position: -1  // -1 indicates this came from cache, not immediate vicinity
            };
            paramMatches.push(cacheMatch);
            matchedParamNames.add(xmlParam.name);
            
            console.log(`[CLASS CACHE HIT] Found "${xmlParam.name}" in class cache: "${cachedDesc.substring(0, 50)}..."`);
        }
    }
    
    // ENRICHMENT PHASE 2: Check global cache ONLY for unmatched named params (not placeholders)
    // This handles parameters that are reused across classes in the same DLL
    for (const xmlParam of xmlParams) {
        // Skip if already matched
        if (matchedParamNames.has(xmlParam.name)) continue;
        
        // Skip placeholder names and invalid names - we don't want to match placeholders globally
        const placeholderPattern = new RegExp(`^(arg|${UNNAMED_ARG_PREFIX})\\d+$`);
        const isPlaceholder = xmlParam.name.match(placeholderPattern);
        const isInvalidName = xmlParam.name.includes(' ') || xmlParam.name.match(/^\d/);
        if (isPlaceholder || isInvalidName) {
            console.log(`[GLOBAL CACHE SKIP] Skipping "${xmlParam.name}" - placeholder=${!!isPlaceholder}, invalid=${!!isInvalidName}`);
            continue;
        }
        
        // Check if this param name exists in global cache
        console.log(`[GLOBAL CACHE CHECK] Looking for "${xmlParam.name}" in global cache (${globalParamCache.size} entries)`);
        const cachedDesc = globalParamCache.get(xmlParam.name);
        if (cachedDesc) {
            /** @type {ParamMatch} */
            const globalMatch = {
                name: xmlParam.name,
                desc: cachedDesc,
                position: -2  // -2 indicates this came from global cache (lowest priority)
            };
            paramMatches.push(globalMatch);
            matchedParamNames.add(xmlParam.name);
            
            console.log(`[GLOBAL CACHE HIT] Found "${xmlParam.name}" in global DLL cache: "${cachedDesc.substring(0, 80)}..."`);
        } else {
            console.log(`[GLOBAL CACHE MISS] "${xmlParam.name}" not found in global cache`);
        }
    }

    return { 
        paramMatches, 
        methodDesc,
        binaryParamCount: paramMatches.length,
        hasCommaSplitCorruption: false  // Will be determined in Stage 2
    };
}

/**
 * STAGE 2: Apply fixes to method based on extracted binary information.
 * Decides what needs fixing by comparing XML data with binary data.
 * * ANTI-PATTERNS / RULES:
 * 1. ONLY trust "paramName: description" patterns from binary.
 * 2. Bare strings (no colon) are unreliable (enum values, other methods) - DO NOT use them for names.
 * 3. DO NOT add multiple method descriptions.
 * 4. DO NOT use position-based matching for non-arg# params.
 * * @param {Property} prop - The method definition object to modify.
 * @param {BinaryMethodInfo} binaryInfo - Extracted binary information.
 * @returns {void}
 */
function applyBinaryFixesToMethod(prop, binaryInfo) {
    const { paramMatches, methodDesc, binaryParamCount } = binaryInfo;
    
    // Rule: Determine if we need full recovery based on XML malformation flags
    // (Set during XML parsing when colon-in-type or other malformations detected)
    const needsFullRecovery = prop._needsFullBinaryRecovery || false;
    
    // COMMA-SPLIT CORRUPTION DETECTION & SURGICAL REMOVAL
    // Strategy: Use comma-count math to determine exactly how many params to remove
    
    const xmlParamCount = prop.params.length;
    
    // Identify parameters in binary that we know are real (have "paramName: description" pattern)
    // This includes BOTH immediate vicinity matches AND class cache matches
    const binaryParamNames = new Set(paramMatches.map(m => m.name));
    
    // Count commas in ALL binary descriptions (including class cache hits)
    // TRUTH: Each comma in a binary description creates one bogus param in XML
    const totalCommasInBinaryDescs = paramMatches.reduce((sum, m) => 
        sum + (m.desc ? (m.desc.match(/,/g) || []).length : 0), 0
    );
    
    // Check if any parameter descriptions contain commas (which could have caused splits)
    const hasCommasInDescriptions = totalCommasInBinaryDescs > 0;
    
    console.log(`[COMMA-SPLIT ANALYSIS] ${prop.name}: Found ${binaryParamNames.size} binary params (${Array.from(binaryParamNames).join(', ')}), ${totalCommasInBinaryDescs} total commas in descriptions`);
    
    // TRUTH: The number of params we should remove is simply the comma count
    // This works because each comma in a binary description creates one extra bogus param in XML
    // We don't need to know the true param count - just remove as many as there are commas
    const numParamsToRemove = totalCommasInBinaryDescs;
    
    // Rule: Comma-split corruption detected when:
    // 1. Binary descriptions contain commas
    // 2. XML has enough extra params that could be from comma splits
    const hasCommaSplitCorruption = hasCommasInDescriptions && xmlParamCount > binaryParamCount && numParamsToRemove > 0;
    
    if (hasCommaSplitCorruption) {
        console.log(`[COMMA-SPLIT ANALYSIS] ${prop.name}: XML has ${xmlParamCount} params, binary shows ${binaryParamCount} with colon patterns, ${totalCommasInBinaryDescs} commas detected, will remove ${numParamsToRemove} params`);
        console.log(`[COMMA-SPLIT] Current params: ${prop.params.map(p => p.name).join(', ')}`);
        console.log(`[COMMA-SPLIT] Binary param names: ${Array.from(binaryParamNames).join(', ')}`);
        
        // SURGICAL REMOVAL STRATEGY:
        // Remove exactly the number of params that match comma-split patterns
        // Priority: sentence fragments > number-prefixed > unmatched arg# placeholders
        
        /** @type {Array<{param: Parameter, priority: number, reason: string}>} */
        const removalCandidates = [];
        
        for (const param of prop.params) {
            // Rule 1: If param name is in binary matches, it's definitely real - NEVER remove
            if (binaryParamNames.has(param.name)) {
                continue;
            }
            
            // Rule 2: Multi-word sentence fragments (highest priority for removal)
            const nameHasMultipleWords = param.name.includes(' ') && param.name.split(/\s+/).length >= 3;
            const nameEndsWithPunctuation = /[.!?,]$/.test(param.name);
            if (nameHasMultipleWords || nameEndsWithPunctuation) {
                removalCandidates.push({ param, priority: 1, reason: 'sentence fragment' });
                continue;
            }
            
            // Rule 3: Number-prefixed names (e.g., "25%", "50%", "75%")
            const nameStartsWithNumber = /^\d/.test(param.name);
            if (nameStartsWithNumber) {
                removalCandidates.push({ param, priority: 2, reason: 'number-prefixed' });
                continue;
            }
            
            // Rule 4: arg# or uArg# placeholders without binary matches (only remove if we need to)
            const placeholderPattern = new RegExp(`^(arg|${UNNAMED_ARG_PREFIX})\\d+$`);
            const isArgPlaceholder = param.name.match(placeholderPattern);
            if (isArgPlaceholder) {
                removalCandidates.push({ param, priority: 3, reason: 'unmatched placeholder' });
                continue;
            }
            
            // Rule 5: Params that had spaces in original XML name (marked during parsing)
            if (param._wasSpaceName) {
                removalCandidates.push({ param, priority: 1, reason: 'space-named in XML' });
                continue;
            }
        }
        
        // Sort by priority (lower number = higher priority for removal)
        removalCandidates.sort((a, b) => a.priority - b.priority);
        
        // Determine how many to actually remove
        // TRUTH: Remove exactly the comma count - each comma created one bogus param
        const numToRemove = Math.min(numParamsToRemove, removalCandidates.length);
        
        if (numToRemove > 0) {
            const paramsToRemove = new Set(removalCandidates.slice(0, numToRemove).map(c => c.param));
            
            /** @type {Array<Parameter>} */
            const paramsToKeep = prop.params.filter(p => !paramsToRemove.has(p));
            
            // Log removals
            for (const candidate of removalCandidates.slice(0, numToRemove)) {
                console.log(`[COMMA-SPLIT REMOVAL] ${prop.name}: Removing "${candidate.param.name}" (${candidate.reason})`);
            }
            
            prop.params = paramsToKeep;
            console.log(`[COMMA-SPLIT FIX] ${prop.name}: Kept ${paramsToKeep.length} params, removed ${numToRemove} bogus params`);
            console.log(`[COMMA-SPLIT] Final params: ${prop.params.map(p => p.name).join(', ')}`);
        } else {
            console.log(`[COMMA-SPLIT] No removal needed - found ${removalCandidates.length} candidates but numToRemove=${numToRemove}`);
        }
    }
    
    // ENRICHMENT: Apply binary descriptions to matched params
    const matchedParams = new Set();

    for (const match of paramMatches) {
        // Attempt 1: Find matching param by exact name
        let targetParam = prop.params.find(/** @param {Parameter} p */ p => p.name === match.name && !matchedParams.has(p));

        // Attempt 2: If not found by name and doing full recovery, try position-based matching for placeholders
        if (!targetParam && needsFullRecovery && match.position < prop.params.length) {
            const candidateParam = prop.params[match.position];
            
            // Rule: Check if parameter is a placeholder (arg# or uArg# pattern)
            const placeholderPattern = new RegExp(`^(arg|${UNNAMED_ARG_PREFIX})\\d+$`);
            const isPlaceholderName = candidateParam.name.match(placeholderPattern);
            
            // Rule: Only match if not already matched and is a placeholder
            const isUnmatchedPlaceholder = !matchedParams.has(candidateParam) && isPlaceholderName;
            
            if (isUnmatchedPlaceholder) {
                targetParam = candidateParam;
                targetParam.name = match.name; // Fix the placeholder name with binary data
            }
        }

        if (targetParam) {
            matchedParams.add(targetParam);
            
            // Rule: Should we update the description?
            const paramHasNoDescription = targetParam.desc.length === 0;
            const shouldOverwriteInFullRecovery = needsFullRecovery;
            const shouldUpdateDesc = match.desc && (paramHasNoDescription || shouldOverwriteInFullRecovery);
            
            if (shouldUpdateDesc) {
                targetParam.desc = [match.desc];
                
                // Rule: Mark as optional if description indicates it
                const descIndicatesOptional = match.desc.toLowerCase().includes("optional");
                if (descIndicatesOptional) {
                    targetParam.optional = true;
                }
            }
        }
    }

    // Apply method description if the property doesn't already have one
    // Rule: Only add method description if one doesn't exist (avoid duplicates)
    const methodHasNoDescription = prop.desc.length === 0;
    const shouldAddMethodDesc = methodDesc && methodHasNoDescription;
    
    if (shouldAddMethodDesc) {
        prop.desc.push(methodDesc);
    }
}

/**
 * DEPRECATED: Old combined function - kept for reference during refactor.
 * Use extractBinaryMethodInfo() and applyBinaryFixesToMethod() instead.
 * * @deprecated
 * @param {Property} prop - The method definition object.
 * @param {Array<string>} foundStrings - Strings found preceding the method name in binary.
 * @param {boolean} fullRecovery - If true, aggressively fix parameter names (for malformed XML).
 */
function applyBinaryStringsToMethod(prop, foundStrings, fullRecovery = true) {
    // foundStrings[0] = string immediately LEFT of method name (param1)
    // foundStrings[1] = string two positions left (param2), etc.

    // fullRecovery=true: Also fix arg# placeholder names using colon patterns
    // fullRecovery=false: Only enrich existing params with matching "paramName: desc" patterns

    const matchedParams = new Set();
    let lastColonPatternIndex = -1; // Track where we last saw a colon pattern

    // First pass: process all colon patterns for params
    for (let i = 0; i < foundStrings.length; i++) {
        const rawString = foundStrings[i];

        // Check for "Name: Description" pattern
        const colonIndex = rawString.indexOf(':');
        const textBeforeColon = colonIndex !== -1 ? rawString.substring(0, colonIndex).trim() : '';
        const hasColonPattern = colonIndex !== -1 &&
            colonIndex < 50 &&
            textBeforeColon.length > 0 &&
            !textBeforeColon.includes(' '); // Name must be single identifier

        if (hasColonPattern) {
            lastColonPatternIndex = i;

            const extractedName = textBeforeColon;
            const extractedDesc = rawString.substring(colonIndex + 1).trim();

            // Find matching param by name
            let targetParam = prop.params.find(/** @param {Parameter} p */ p => p.name === extractedName && !matchedParams.has(p));

            // If not found by name and doing full recovery, try matching by position for placeholder names
            // This rescues params that were named 'arg0', 'arg1' due to XML corruption
            if (!targetParam && fullRecovery && i < prop.params.length) {
                const p = prop.params[i];
                if (!matchedParams.has(p) && p.name.startsWith('arg') && /^\d+$/.test(p.name.substring(3))) {
                    targetParam = p;
                    targetParam.name = extractedName; // Fix the placeholder name
                }
            }

            if (targetParam) {
                matchedParams.add(targetParam);
                // Add description if param doesn't have one, or if doing full recovery
                if (extractedDesc && (targetParam.desc.length === 0 || fullRecovery)) {
                    targetParam.desc = [extractedDesc];
                    // Mark as optional if description indicates it
                    if (extractedDesc.toLowerCase().includes("optional")) {
                        targetParam.optional = true;
                    }
                }
            }
        }
    }

    // Second pass: look for method description immediately after the last colon pattern
    // TRUTH: The method description is always the string immediately preceding the last parameter definition in binary
    // (In our reversed foundStrings array, that means index + 1)
    if (lastColonPatternIndex >= 0 && lastColonPatternIndex + 1 < foundStrings.length) {
        const methodDescCandidate = foundStrings[lastColonPatternIndex + 1].trim();

        // Must be a reasonable description (not empty, has spaces, doesn't look like garbage)
        if (methodDescCandidate.length > 15 &&
            methodDescCandidate.includes(' ') &&
            !methodDescCandidate.endsWith(" class") &&
            prop.desc.length === 0) {
            prop.desc.push(methodDescCandidate);
        }
    }
}


// ==========================================
// PARAMETER CLEANUP
// ==========================================

// REMOVED - At the XML stage, we DON'T remove any parameters. We'll wait till the binary stage to know for sure.
// /**
//  * Clean up bogus parameters created by comma-splitting errors in XML.
//  * We can't know for sure what's bogus until we check the binary.
//  * The XML might have the correct number of params, just with wrong names/descriptions.
//  * * The binary stage will handle all parameter removal/correction based on the ground truth.
//  * * This function is kept for potential light cleanup in the future, but currently
//  * just passes through all parameters with their metadata intact (_wasSpaceName, etc.)
//  * * @param {Array<Parameter>} params - List of parameter objects.
//  * @returns {Array<Parameter>} - List of parameters (unchanged at XML stage).
//  */
// function cleanupBogusParams(params) {
//     // At XML stage: Keep ALL parameters
//     // Binary stage will decide what to remove based on ground truth
//     return params;
// }

// #region XML Parsing
// ==========================================
// XML PARSING (Standard)
// ==========================================

/**
 * Helper: Find all child elements matching a nested path.
 * Used because standard DOM selectors can be flaky with XML namespaces/structures in these files.
 * @param {Element} element - Root element.
 * @param {Array<string>} selector - Array of tag names for path.
 * @returns {Array<Element>}
 */
function directFindAll(element, selector) {
    /** @type {Array<Element>} */
    let result = [];
    const currentSelector = selector.shift();
    if (currentSelector) {
        for (const child of Array.from(element.children)) {
            if (child.nodeName === currentSelector) {
                result = result.concat(directFindAll(child, selector.slice()));
            }
        }
    } else {
        result.push(element);
    }
    return result;
}

/**
 * Helper: Find the first child element matching a nested path.
 * @param {Element} element 
 * @param {Array<string>} selector
 * @returns {Element|undefined}
 */
function directFind(element, selector) {
    const currentSelector = selector.shift();
    if (currentSelector) {
        for (const child of Array.from(element.children)) {
            if (child.nodeName === currentSelector) {
                const found = directFind(child, selector.slice());
                if (found) return found;
            }
        }
    } else {
        return element;
    }
}

/**
 * Primary parser for the XML Document.
 * Traverses the XML tree to find all Package and Class definitions.
 * @param {Document} xmlDocument 
 * @returns {Array<Definition>} - Array of parsed definition objects (AST).
 */
function parse(xmlDocument) {
    const result = [];
    const definitions = directFindAll(xmlDocument.documentElement, ["package", "classdef"]);
    for (const definition of definitions) {
        result.push(parseDefinition(definition));
    }
    removeInheritedProperties(result);
    return result;
}

/**
 * Parses a single Class, Interface, or Enum definition.
 * @param {Element} definition - The XML element for the definition.
 * @returns {Definition} - Parsed definition object.
 */
function parseDefinition(definition) {
    const constructorEl = directFind(definition, ["elements", "constructor"]);
    let type;
    if (definition.getAttribute("enumeration")) {
        type = "enum";
    } else if (definition.getAttribute("dynamic")) {
        type = constructorEl ? "class" : "interface";
    } else {
        throw new Error("Unknown definition");
    }

    const props = [];
    for (const element of directFindAll(definition, ["elements"])) {
        const typeAttr = element.getAttribute("type");
        const isStatic = typeAttr === "class";
        const isConstructor = typeAttr === "constructor";
        for (const property of Array.from(element.children)) {
            props.push(parseProperty(property, isStatic, isConstructor));
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

/**
 * Parses a property or method definition.
 * Contains critical logic for detecting XML corruption that requires binary recovery.
 * * @param {Element} prop - The property/method XML element.
 * @param {boolean} isStatic 
 * @param {boolean} isConstructor
 * @returns {Property} - Parsed property/method object.
 */
function parseProperty(prop, isStatic, isConstructor) {
    let type;
    if (prop.getAttribute("name") === ".index") {
        type = "indexer";
    } else if (prop.nodeName === "property") {
        type = "property";
    } else if (prop.nodeName === "method") {
        type = "method";
    } else {
        throw new Error("Unknown property " + prop.nodeName);
    }

    const typeInfo = parseType(directFind(prop, ["datatype"]));

    const params = parseParameters(directFindAll(prop, ["parameters", "parameter"]));

    // BEFORE cleanup: Capture method description from last param if present.
    // TRUTH: The XML engine incorrectly dumps the method description onto the 
    // description of the LAST parameter. We must rescue this before cleanup removes it.
    // IMPORTANT: Only rescue XML descriptions, NOT type-derived ones (from malformed types)
    /** @type {Array<string>} */
    let rescuedMethodDesc = [];
    if (params.length > 0) {
        const lastParam = params[params.length - 1];
        const othersHaveDesc = params.slice(0, -1).some(param => param.desc.length > 0);
        // Only rescue if: last param has desc, others don't, AND the desc came from XML originally
        const descIsFromXml = lastParam._descFromXml === true;
        if (lastParam.desc.length > 0 && !othersHaveDesc && descIsFromXml) {
            // Only rescue the XML descriptions, not type-derived ones
            // _xmlDescCount tells us how many came from XML before type-parsing added more
            const xmlDescCount = lastParam._xmlDescCount || 0;
            rescuedMethodDesc = lastParam.desc.slice(0, xmlDescCount);
            // Remove only the rescued descriptions from the param, keep type-derived ones
            lastParam.desc = lastParam.desc.slice(xmlDescCount);
        }
    }

    // Detect if this method needs FULL binary recovery (due to malformed types detected in parseType)
    const needsFullBinaryRecovery = params.some(p => p._malformed);

    // Also flag for LIGHT binary lookup if we have params that could be enriched with better descriptions
    const hasParamsToEnrich = params.length > 0;

    const p = {
        type,
        isStatic,
        readonly: prop.getAttribute("rwaccess") === "readonly",
        name: isConstructor ? "constructor" : (prop.getAttribute("name") || "").replace(/[^\[\]0-9a-zA-Z_$.]/g, "_"),
        desc: parseDesc(prop),
        params: params,
        types: typeInfo.types,
        _needsFullBinaryRecovery: needsFullBinaryRecovery, // Flag for full DLL recovery
        _hasParamsToEnrich: hasParamsToEnrich, // Flag for param desc enrichment
    };

    // Apply rescued method description to the method itself
    if (rescuedMethodDesc.length > 0 && p.desc.length === 0) {
        p.desc = rescuedMethodDesc;
    } else if (rescuedMethodDesc.length > 0) {
        p.desc = p.desc.concat(rescuedMethodDesc);
    }

    if (typeInfo.newDesc) {
        p.desc.unshift(typeInfo.newDesc);
    }

    if (type === 'indexer') {
        p.name = "__indexer";
    }

    parseCanReturnAndAccept(p);
    return p;
}

/**
 * Extracts and cleans descriptions from XML elements.
 * Joins shortdesc and description tags.
 * @param {Element} element
 * @returns {Array<string>}
 */
function parseDesc(element) {
    let desc = [];
    const shortdesc = directFind(element, ["shortdesc"]);
    if (shortdesc && shortdesc.textContent) desc.push(shortdesc.textContent);
    const description = directFind(element, ["description"]);
    if (description && description.textContent) desc.push(description.textContent);

    return desc.join("\n").split("\n")
        .map(d => d.replace(/ {2}/g, "").trim())
        .filter(d => d !== "");
}

/**
 * Parses parameter list from XML.
 * Handles "Parameter name corruption" where params starting with digits
 * or containing spaces are actually fragments of descriptions.
 * * @param {Array<Element>} parameters
 * @returns {Array<Parameter>} - Array of parsed parameter objects.
 */
function parseParameters(parameters) {
    const finalParams = [];
    let previousWasOptional = false;

    // First pass: collect all existing uArg# names to avoid duplicates
    const existingUnknownNames = new Set();
    const existingPlaceholderPattern = new RegExp(`^${UNNAMED_ARG_PREFIX}\\d+$`);
    for (const parameterElement of parameters) {
        const paramName = parameterElement.getAttribute("name") || "";
        if (paramName.match(existingPlaceholderPattern)) {
            existingUnknownNames.add(paramName);
        }
    }

    // Helper to generate unique uArg# name
    let unknownCounter = 1;
    const generateUnknownName = () => {
        while (existingUnknownNames.has(`${UNNAMED_ARG_PREFIX}${unknownCounter}`)) {
            unknownCounter++;
        }
        const name = `${UNNAMED_ARG_PREFIX}${unknownCounter}`;
        existingUnknownNames.add(name);
        unknownCounter++;
        return name;
    };

    for (const [i, parameterElement] of parameters.entries()) {
        let paramName = parameterElement.getAttribute("name") || "";
        let paramDesc = parseDesc(parameterElement);

        // Track whether description came from XML shortdesc tag
        const hasXmlDesc = paramDesc.length > 0;

        // Rule: Detect invalid parameter names
        const hasSpaceInName = paramName.includes(" ");
        const startsWithNumber = !!paramName.match(/^\d/);

        // TRUTH: Names starting with digits (like "6 StretchToFillBeforeCrop") are garbage from XML corruption
        // TRUTH: Names with spaces but NOT starting with digits (like "Job name") are actually descriptions
        let wasSpaceName = false;
        if (startsWithNumber) {
            // This is garbage from XML corruption - discard it
            // Binary stage will recover the correct data
            paramName = generateUnknownName();
        } else if (hasSpaceInName) {
            // This is a description mistakenly placed in the name attribute
            // Use it as description and generate a placeholder name
            const cleanedDesc = paramName.trim();
            if (cleanedDesc) {
                paramDesc.unshift(cleanedDesc);
            }
            paramName = generateUnknownName();
            wasSpaceName = true; // Mark that this is a legitimate param from space-name conversion
        } else if (!paramName) {
            paramName = generateUnknownName();
        }

        const typeInfo = parseType(directFind(parameterElement, ["datatype"]));
        
        // Track how many descriptions we have from XML before adding type-derived ones
        const xmlDescCount = paramDesc.length;
        
        if (typeInfo.newDesc) paramDesc.push(typeInfo.newDesc);

        const param = /** @type {Parameter} */ ({
            name: paramName,
            desc: paramDesc.filter(d => d && d.trim() !== ''),
            optional: previousWasOptional || !!parameterElement.getAttribute("optional"),
            types: typeInfo.types,
            _malformed: typeInfo.hasMalformedType, // Internal flag for binary recovery
            _descFromXml: hasXmlDesc, // Track if desc came from XML shortdesc vs invalid param name
            _wasSpaceName: wasSpaceName, // Track if this arg# came from space-name conversion (legitimate)
            _xmlDescCount: xmlDescCount, // Count of XML descriptions (before type-derived ones)
        });

        if (param.desc.join(" ").toLowerCase().includes("optional")) {
            param.optional = true;
        }
        param.desc = param.desc.map(d => d.replace(/\(Optional\)/i, ""));

        if (param.name.includes("...")) {
            param.name = "...rest";
            if (param.types[0]) param.types[0].isArray = true;
        }

        finalParams.push(param);
        previousWasOptional = param.optional;
    }
    return finalParams;
}

/**
 * Parses type information and detects major XML corruption.
 * * TRUTH / XML ERROR - "Colon splitting error":
 * If dev wrote "matchSource: Optional. Default value is false", 
 * engine appends ":boolean", creating "matchSource: Optional. Default... :boolean".
 * The XML generator splits on the FIRST colon, so the type becomes "Optional. Default... :boolean".
 * * Logic below detects this pattern via regex `/(.*):(\S+)$/` to flag malformed types.
 * * @param {Element|undefined} datatype 
 * @returns {{types: Array<TypeInfo>, newDesc?: string, hasMalformedType: boolean}}
 */
function parseType(datatype) {
    const types = [];
    let newDesc;
    let hasMalformedType = false; // Flag: type contained colon (XML parser split wrong)

    if (datatype) {
        const typeElement = directFind(datatype, ["type"]);
        const valueElement = directFind(datatype, ["value"]);

        let originalTypeName = typeElement ? typeElement.textContent || "" : "";
        const typeMatch = originalTypeName.match(/(.*):(\S+)$/);

        if (typeMatch) {
            hasMalformedType = true; // This is the key indicator of malformation!
            newDesc = typeMatch[1].trim().replace(/\.$/, '');
            originalTypeName = typeMatch[2];
        } else if (originalTypeName.includes(' ')) {
            newDesc = originalTypeName;
            originalTypeName = 'any';
        }

        const type = {
            name: originalTypeName,
            isArray: !!directFind(datatype, ["array"]),
            value: valueElement ? valueElement.textContent || "" : undefined,
        };

        if (type.name === "Measurement Unit (Number or String)=any") {
            type.name = "number | string";
            if (type.isArray) type.name = "(" + type.name + ")";
        }

        parseTypeFixTypeName(type);
        if (type.name) types.push(type);
    } else {
        types.push({ name: "void", isArray: false });
    }
    return { types, newDesc, hasMalformedType };
}

/**
 * Parses method descriptions for "Can return/accept: Type" patterns to augment type definitions.
 * @param {Property} obj - The property/method object.
 */
function parseCanReturnAndAccept(obj) {
    const str = obj.desc[0];
    if (!str) return;
    const match = str.match(/^(.*?)(?:Can(?: also)? (?:accept|return):)(.*)$/);
    if (!match || match[2].includes("containing") || match[2].match(/Arrays? of Arrays? of/)) return;

    match[2] = match[2].replace("Can also accept:", " or ");
    const result = parseCanReturnAndAcceptValue(match[2]);
    if (result) {
        obj.desc[0] = match[1].trim();
        obj.types = obj.types.concat(result);
        obj.types = obj.types.filter((type) => type.name !== "any");
    }
}

/**
 * Helper to parse the values extracted from "Can return/accept" strings.
 * @param {string} str 
 */
function parseCanReturnAndAcceptValue(str) {
    let types = [];
    const words = str.split(/,| or/);
    for (const word of words) {
        const type = { name: word.trim(), isArray: false };
        if (!type.name || type.name === ".") continue;
        parseTypeFixTypeName(type);
        types.push(type);
    }
    return types.filter((type, index, self) =>
        self.findIndex((t) => t.name === type.name && t.isArray === type.isArray) === index
    );
}

/**
 * Normalizes Adobe's varied and inconsistent type names into valid TypeScript types.
 * Handles specific Adobe quirks like "Unit", "Real", "Int32", "Object", and legacy typos like "Swatche".
 * * @param {TypeInfo} type - The type object to normalize.
 */
function parseTypeFixTypeName(type) {
    // Basic cleanup: remove trailing dots, trim whitespace, remove "enumerator" suffix
    type.name = type.name.trim().replace(/enumerators?/, "").replace(/\.$/, "").trim();

    // Map Adobe-specific type strings to TypeScript primitives
    if (type.name === "varies=any" || type.name === "Any") type.name = "any";
    else if (type.name === "Undefined") type.name = "undefined";
    else if (type.name === "Object") type.name = "object";
    else if (type.name === "String") type.name = "string";
    else if (type.name === "Boolean" || type.name === "bool") type.name = "boolean";
    // Map various integer/number formats to 'number'
    else if (type.name === "Number" || type.name === "int" || type.name === "Int32" || type.name === "uint") type.name = "number";

    // Handle "Unit" and "Real" types, often with range definitions in the string (e.g., "Unit (0.0 - 100.0)")
    else if (type.name.match(/^(Unit|Real)\s*(\([\d.]+ - [\d.]+( points)?\))?$/)) type.name = "number";

    // Handle fixed-length arrays defined as strings
    else if (type.name === "Array of 4 Units (0 - 8640 points)") { type.name = "[number, number, number, number]"; type.isArray = false; }
    else if (type.name === "Array of Reals") { type.name = "number"; type.isArray = true; }
    else if (type.name.match(/Arrays? of 2 Reals/)) type.name = "[number, number]";
    else if (type.name.match(/Arrays? of 3 Reals/)) type.name = "[number, number, number]";
    else if (type.name.match(/Arrays? of 6 Reals/)) type.name = "[number, number, number, number, number, number]";
    else if (type.name.match(/Arrays? of 2 Units/)) type.name = "[number | string, number | string]";
    else if (type.name.match(/Arrays? of 2 Strings/)) type.name = "[string, string]";

    // Handle legacy integer types
    else if (type.name.match(/(Short|Long) Integers?/)) type.name = "number";

    // Recursive handling for "Array of X" patterns
    else if (type.name.startsWith("Array of ")) {
        type.name = type.name.replace(/^Array of (\S+?)s?$/, "$1").trim();
        type.isArray = true;
        parseTypeFixTypeName(type); // Recurse to fix the inner type
    }

    // Fix known typos in Adobe's XML
    else if (type.name === "Swatche") type.name = "Swatch";
    else if (type.name === "JavaScript Function") type.name = "Function";
}

// #region TS Cleanup
// ==========================================
// POST-PROCESSING & CLEANUP
// ==========================================

/**
 * Removes properties from classes that are already defined in their superclasses.
 * The XML DOM often redundantly lists inherited members. In TypeScript, we use 'extends',
 * so listing them again is unnecessary and can cause conflicts if types slightly differ.
 * * @param {Array<Definition>} definitions - The full list of parsed definitions.
 */
function removeInheritedProperties(definitions) {
    for (const definition of definitions) {
        const props = getListOfPropsToBeRemovedFor(definition, definitions);
        for (const prop of props) {
            definition.props = definition.props.filter(p => p.name !== prop);
        }
    }
}

/**
 * Recursively finds all property names inherited from the superclass chain.
 * Helper for removeInheritedProperties.
 * * @param {Definition} definition - The current class definition.
 * @param {Array<Definition>} definitions - All definitions (for looking up parents).
 * @returns {Array<string>} - List of property names to remove.
 */
function getListOfPropsToBeRemovedFor(definition, definitions) {
    /** @type {Array<string>} */
    let props = [];
    if (definition.extend) {
        const parent = definitions.find(d => d.name === definition.extend);
        if (parent) {
            // Add all parent properties to the removal list
            for (const prop of parent.props) {
                props.push(prop.name);
            }
            // Recurse up the tree
            props = props.concat(getListOfPropsToBeRemovedFor(parent, definitions));
        }
    }
    return props;
}

/**
 * Sorts definitions and their properties to ensure deterministic output.
 * 1. Sorts classes by name.
 * 2. Sorts properties: Methods first, then by name.
 * * @param {Array<Definition>} definitions - The unsorted AST.
 * @returns {Array<Definition>} - The sorted AST.
 */
function sort(definitions) {
    // Sort main definitions alphabetically
    definitions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const definition of definitions) {
        definition.props.sort((a, b) => {
            // Sort by type: methods vs properties
            if (a.type !== b.type) {
                if (a.type === 'method') return 1;
                if (b.type === 'method') return -1;
            }
            // Then sort alphabetically
            return (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        });
    }
    return definitions;
}

// #region .d.ts File Gen
// ==========================================
// CODE GENERATION (.d.ts)
// ==========================================

/**
 * Converts the AST into the final TypeScript declaration string.
 * Handles splitting classes into namespaces (e.g., "Premiere.Project" -> namespace Premiere { class Project }).
 * * @param {Array<Definition>} definitions - The sorted and fixed AST.
 * @returns {string} - The complete .d.ts file content.
 */
function generate(definitions) {
    /** @type {Record<string, Array<Definition>>} */
    const namespaces = {};
    const rootDefinitions = [];

    // Separate definitions into Root vs Namespaced
    for (const def of definitions) {
        if (def.name.includes('.')) {
            const parts = def.name.split('.');
            const ns = parts[0];
            const className = parts.slice(1).join('.');
            if (!namespaces[ns]) namespaces[ns] = [];
            namespaces[ns].push(Object.assign({}, def, { name: className }));
        } else {
            rootDefinitions.push(def);
        }
    }

    let output = "";

    // Generate root definitions first
    for (const definition of rootDefinitions) output += generateDefinition(definition);

    // Generate namespaced definitions
    for (const nsName in namespaces) {
        output += "declare namespace " + nsName + " {\n";
        for (const definition of namespaces[nsName]) output += generateDefinition(definition, "\t");
        output += "}\n\n";
    }
    return output;
}

/**
 * Generates the TypeScript string for a single class, interface, or enum.
 * * @param {Definition} definition - The definition object.
 * @param {string} indent - Current indentation string (e.g., "\t").
 */
function generateDefinition(definition, indent = "") {
    let output = "";

    // Class/Interface JSDoc
    if (definition.desc.length > 0) { // If no description, don't add the comment lines, they'll just be blank
        output += indent + "/**\n" + indent + " * " + definition.desc.join("\n" + indent + " * ") + "\n" + indent + " */\n";
    }
    
    const name = "declare " + definition.type + " " + definition.name;
    const extend = definition.extend ? " extends " + definition.extend : "";
    output += indent + name + extend + " {\n";

    // Track whether the previous property had JSDoc lines so we can add a space after that. Otherwise don't add space between properties/methods without comments
    // Set the first one to true as default so it adds a space for the first one
    let previousPropHadDescription = true;

    for (const prop of definition.props) {
        let propCommentLines = "";
        let propSignatureString = "";
        const propIndent = indent + "\t";
        
        const propDescriptionLine = propIndent + " * " + prop.desc.join("\n" + propIndent + " * ") + "\n"
        propCommentLines += propIndent + "/**\n" + propDescriptionLine;

        if (prop.type === "method" || prop.type === "indexer") {
            // Generate Method Signature
            const params = prop.params.map(param => {
                const methodName = generateFixParamName(param.name);
                const desc = param.desc.join(" ").trim();
                // Add @param JSDoc
                if (desc) propCommentLines += propIndent + " * @param " + methodName + " " + desc + "\n";
                return methodName + (param.optional ? "?" : "") + ": " + generateType(param.types);
            });
            propCommentLines += propIndent + " */\n";

            const type = generateType(prop.types);
            const staticKeyword = (prop.isStatic ? "static " : "");
            const readonlyKeyword = (prop.readonly ? "readonly " : "");

            if (prop.type === "indexer") {
                propSignatureString += propIndent + readonlyKeyword + "[" + params.join(", ") + "]: " + type + ";\n";
            } else if (prop.name === "constructor") {
                propSignatureString += propIndent + "constructor(" + params.join(", ") + ");\n";
            } else {
                propSignatureString += propIndent + staticKeyword + prop.name + "(" + params.join(", ") + "): " + type + ";\n";
            }
        }
        else if (definition.type === "class" || definition.type === "interface") {
            // Nested Class/Interface property (used in dynamic definitions)
            propCommentLines += propIndent + " */\n";
            const className = prop.name === "constructor" ? "'constructor'" : prop.name;
            const staticKeyword = (prop.isStatic ? "static " : "");
            const readonlyKeyword = (prop.readonly ? "readonly " : "");
            const type = generateType(prop.types);
            propSignatureString += propIndent + staticKeyword + readonlyKeyword + className + ": " + type + ";\n";
        }
        else if (definition.type === "enum") {
            // Enum Member
            propCommentLines += propIndent + " */\n";
            propSignatureString += propIndent + prop.name + " = " + prop.types[0].value + ",\n";
        }

        // Check if there is actually any description contents
        let testTrimmedPropComments = propCommentLines;
        testTrimmedPropComments = testTrimmedPropComments.replace(/\n/g, "").replace(/\t/g, "").replace(/\*/g, "").replace(/ /g, "").replace(/\//g, "");

        // Don't bother adding lines between properties/methods that don't have descriptions
        if (testTrimmedPropComments.length > 0 || previousPropHadDescription === true) {
            output += "\n";
        }
         
        if (testTrimmedPropComments.length > 0) {
            output += propCommentLines;
            previousPropHadDescription = true;
        } else {
            previousPropHadDescription = false;
        }
        
        output += propSignatureString;
    }
    output += indent + "}\n\n";
    return output;
}

/**
 * Joins multiple types with union separator "|".
 * * @param {Array<TypeInfo>} types - List of type objects.
 */
function generateType(types) {
    const output = [];
    for (const type of types) output.push(type.name + (type.isArray ? "[]" : ""));
    return output.join(" | ");
}

/**
 * Escapes parameter names that conflict with TypeScript reserved keywords.
 * Adds an underscore suffix (e.g., "default" -> "default_").
 * * @param {string} name 
 */
function generateFixParamName(name) {
    if (["for", "with", "in", "default", "return", "export", "function"].includes(name)) return name + "_";
    return name;
}