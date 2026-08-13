const { parse } = require('csv-parse/sync');

const MAX_CATEGORY_LENGTH = 40;
const VALID_ROUNDS = [1, 2, 3];
const VALID_DIFFICULTIES = [1, 2, 3, 4, 5];

// Category names go through the board via `innerText` (see jeopardy.html createBoard()),
// so they must NOT be HTML-escaped here or entities like "&amp;" would render literally.
// Hint/answer text and the Final Jeopardy fields go through `innerHTML`, so those ARE escaped.
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeHeader(header) {
    return String(header)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

const FIELD_ALIASES = {
    name: ['name', 'category'],
    difficulty: ['difficulty', 'value'],
    question: ['question', 'hint', 'clue'],
    answer: ['answer'],
    roundOrder: ['round order', 'round'],
    isDoubleJeopardy: ['isdoublejeopardy', 'double jeopardy', 'is double jeopardy'],
    imageUrl: ['image url', 'imageurl', 'image']
};

const REQUIRED_FIELDS = ['name', 'difficulty', 'question', 'answer', 'roundOrder'];

function buildFieldMap(headerKeys) {
    const normalizedToOriginal = new Map();
    headerKeys.forEach(key => {
        normalizedToOriginal.set(normalizeHeader(key), key);
    });

    const fieldMap = {};
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
        for (const alias of aliases) {
            if (normalizedToOriginal.has(alias)) {
                fieldMap[field] = normalizedToOriginal.get(alias);
                break;
            }
        }
    }
    return fieldMap;
}

function getField(row, fieldMap, field) {
    const key = fieldMap[field];
    if (!key) return '';
    const value = row[key];
    return value === undefined || value === null ? '' : String(value).trim();
}

// Parses a game CSV into the same {round1,round2,round3,finalJeopardy} shape
// jeopardy.html already consumes. Returns { gameData: null, errors: [...] } if
// the CSV fails validation, or { gameData: {...}, errors: [] } on success.
function parseGameCsv(buffer) {
    const errors = [];
    let records;

    try {
        records = parse(buffer, {
            columns: true,
            skip_empty_lines: true,
            bom: true
        });
    } catch (err) {
        return { gameData: null, errors: [`Could not parse CSV: ${err.message}`] };
    }

    if (records.length === 0) {
        return { gameData: null, errors: ['CSV file has no data rows.'] };
    }

    const fieldMap = buildFieldMap(Object.keys(records[0]));
    const missingRequired = REQUIRED_FIELDS.filter(f => !fieldMap[f]);
    if (missingRequired.length > 0) {
        return {
            gameData: null,
            errors: [`CSV is missing required column(s): ${missingRequired.join(', ')}. ` +
                'Expected columns: Name, Difficulty, Question, Answer, "Round, order" (isDoubleJeopardy and Image URL are optional).']
        };
    }

    // rounds[roundNum] = Map<categoryName, { order, questions: Map<difficulty, {...}> }>
    const rounds = { 1: new Map(), 2: new Map(), 3: new Map() };
    let finalJeopardy = null;
    let finalJeopardyRowSeen = false;

    records.forEach((row, idx) => {
        const rowNum = idx + 2; // +1 for 0-index, +1 for header row
        const name = getField(row, fieldMap, 'name');
        const question = getField(row, fieldMap, 'question');
        const answer = getField(row, fieldMap, 'answer');
        const roundOrderRaw = getField(row, fieldMap, 'roundOrder');
        const imageUrlRaw = getField(row, fieldMap, 'imageUrl');
        const imageUrl = imageUrlRaw || null;

        if (!roundOrderRaw) {
            errors.push(`Row ${rowNum}: missing "Round, order" value.`);
            return;
        }

        if (roundOrderRaw.toLowerCase() === 'final jeopardy') {
            if (finalJeopardyRowSeen) {
                errors.push(`Row ${rowNum}: multiple "Final Jeopardy" rows found (only one is allowed).`);
                return;
            }
            finalJeopardyRowSeen = true;

            if (!name) errors.push(`Row ${rowNum}: Final Jeopardy row is missing a category name.`);
            if (!question) errors.push(`Row ${rowNum}: Final Jeopardy row is missing its hint (Question column).`);
            if (!answer) errors.push(`Row ${rowNum}: Final Jeopardy row is missing its answer.`);
            if (name && name.length > MAX_CATEGORY_LENGTH) {
                errors.push(`Row ${rowNum}: Final Jeopardy category name exceeds ${MAX_CATEGORY_LENGTH} characters.`);
            }

            if (name && question && answer) {
                finalJeopardy = {
                    category: escapeHtml(name),
                    hint: escapeHtml(question),
                    answer: escapeHtml(answer),
                    imageUrl
                };
            }
            return;
        }

        const parts = roundOrderRaw.split(',').map(p => p.trim());
        if (parts.length !== 2) {
            errors.push(`Row ${rowNum}: invalid "Round, order" value "${roundOrderRaw}" (expected e.g. "1,3" or "Final Jeopardy").`);
            return;
        }

        const round = parseInt(parts[0], 10);
        const order = parseInt(parts[1], 10);

        if (!VALID_ROUNDS.includes(round)) {
            errors.push(`Row ${rowNum}: round must be 1, 2, or 3 (got "${parts[0]}").`);
            return;
        }
        if (!Number.isInteger(order) || order < 1 || order > 5) {
            errors.push(`Row ${rowNum}: category order must be 1-5 (got "${parts[1]}").`);
            return;
        }

        const difficultyRaw = getField(row, fieldMap, 'difficulty');
        const difficulty = parseInt(difficultyRaw, 10);
        if (!VALID_DIFFICULTIES.includes(difficulty)) {
            errors.push(`Row ${rowNum}: Difficulty must be 1-5 (got "${difficultyRaw}").`);
            return;
        }

        if (!name) {
            errors.push(`Row ${rowNum}: missing category name.`);
            return;
        }
        if (name.length > MAX_CATEGORY_LENGTH) {
            errors.push(`Row ${rowNum}: category name "${name}" exceeds ${MAX_CATEGORY_LENGTH} characters.`);
            return;
        }
        if (!question) {
            errors.push(`Row ${rowNum}: missing question text for category "${name}".`);
            return;
        }
        if (!answer) {
            errors.push(`Row ${rowNum}: missing answer text for category "${name}".`);
            return;
        }

        const isDoubleJeopardyRaw = getField(row, fieldMap, 'isDoubleJeopardy');
        const doubleJeopardy = isDoubleJeopardyRaw.toUpperCase() === 'TRUE';

        const roundMap = rounds[round];
        let categoryEntry = roundMap.get(name);
        if (!categoryEntry) {
            categoryEntry = { order, questions: new Map() };
            roundMap.set(name, categoryEntry);
        } else if (categoryEntry.order !== order) {
            errors.push(`Row ${rowNum}: category "${name}" (round ${round}) has order ${order} here but order ${categoryEntry.order} in an earlier row — all rows for a category must use the same order value.`);
            return;
        }

        if (categoryEntry.questions.has(difficulty)) {
            errors.push(`Row ${rowNum}: category "${name}" (round ${round}) already has a difficulty ${difficulty} question — duplicate row.`);
            return;
        }

        categoryEntry.questions.set(difficulty, {
            hint: escapeHtml(question),
            answer: escapeHtml(answer),
            doubleJeopardy,
            imageUrl
        });
    });

    // Cross-row structural validation: exactly 5 distinct categories per populated
    // round, orders forming exactly {1..5}, and every category has all 5 difficulties.
    for (const round of VALID_ROUNDS) {
        const roundMap = rounds[round];
        if (roundMap.size === 0) continue; // round entirely absent is fine (matches real sample data)

        if (roundMap.size !== 5) {
            errors.push(`Round ${round} has ${roundMap.size} distinct categor${roundMap.size === 1 ? 'y' : 'ies'}, expected exactly 5.`);
        }

        const seenOrders = new Map(); // order -> categoryName, to catch two categories claiming the same slot
        for (const [categoryName, entry] of roundMap.entries()) {
            if (seenOrders.has(entry.order)) {
                errors.push(`Round ${round}: categories "${seenOrders.get(entry.order)}" and "${categoryName}" both claim order ${entry.order}.`);
            } else {
                seenOrders.set(entry.order, categoryName);
            }

            const missingDifficulties = VALID_DIFFICULTIES.filter(d => !entry.questions.has(d));
            if (missingDifficulties.length > 0) {
                errors.push(`Round ${round} category "${categoryName}" is missing difficulty level(s): ${missingDifficulties.join(', ')}.`);
            }
        }
    }

    if (errors.length > 0) {
        return { gameData: null, errors };
    }

    const gameData = {};
    for (const round of VALID_ROUNDS) {
        const roundMap = rounds[round];
        const questions = {};

        const categoriesInOrder = Array.from(roundMap.entries()).sort((a, b) => a[1].order - b[1].order);
        for (const [categoryName, entry] of categoriesInOrder) {
            questions[categoryName] = VALID_DIFFICULTIES.map(d => entry.questions.get(d));
        }

        gameData[`round${round}`] = { questions };
    }

    gameData.finalJeopardy = finalJeopardy || { category: '', hint: '', answer: '', imageUrl: null };

    return { gameData, errors: [] };
}

module.exports = { parseGameCsv, escapeHtml };
