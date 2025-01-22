module.exports = {
    runTask: async function () {
        try {
            this.logInfo("Initializing bias analysis task...");
            const llmModule = await this.loadModule("llm");
            const personalityModule = await this.loadModule("personality");
            const utilModule = await this.loadModule("util");
            const documentModule = await this.loadModule("document");

            // Helper functions
            const ensureValidJson = async (jsonString, maxIterations = 1, jsonSchema = null, correctExample = null) => {
                const phases = {
                    "RemoveJsonMark": async (jsonString, error) => {
                        if (jsonString.startsWith("```json")) {
                            jsonString = jsonString.slice(7);
                            if (jsonString.endsWith("```")) {
                                jsonString = jsonString.slice(0, -3);
                            }
                        }
                        return jsonString;
                    },
                    "RemoveOutsideJson": async (jsonString, error) => {
                        if (jsonString.includes("```json")) {
                            const parts = jsonString.split("```json");
                            if (parts.length > 1) {
                                jsonString = parts[1];
                                jsonString = jsonString.split("```")[0];
                            }
                        }
                        return jsonString;
                    },
                    "RemoveNewLine": async (jsonString, error) => {
                        return jsonString.replace(/\n/g, "");
                    },
                    "TrimSpaces": async (jsonString, error) => {
                        return jsonString.trim();
                    },
                    "LlmHelper": async (jsonString, error) => {
                        let prompt = `
                         ** Role:**
                           - You are a global expert in correcting an invalid JSON string to a valid JSON string that is parsable by a JSON parser
                         ** Instructions:**
                            - You will be provided with an invalid JSON string that needs to be corrected.
                            - You will be provided with an error message given by the parser that will help you identify the issue in the JSON string.
                            ${jsonSchema ? `- You will be provided with a JSON schema that the corrected JSON string should adhere to.` : ""}
                            ${correctExample ? `- You will be provided with an example of a correct JSON string that adheres to the schema` : ""}

                         ** Input JSON string that needs to be corrected:**
                         "${jsonString}"

                         ** Error message given by the parser:**
                            "${error}"
                            ${jsonSchema ? `** JSON Schema Template:**\n"${jsonSchema}"\n` : ""}
                            ${correctExample ? `** Example of a correct JSON string that adheres to the schema:**\n"${correctExample}"\n` : ""}
                         **Output Specifications:**
                             - Provide the corrected JSON string that is valid and parsable by a JSON parser.
                             - Your answer should not include any code block markers (e.g., \`\`\`json).
                            - Your answer should not include additional text, information, metadata or meta-commentary
                        `;

                        const response = await llmModule.generateText(this.spaceId, prompt, this.parameters.personality);
                        return response.message;
                    }
                };

                const phaseFunctions = Object.values(phases);

                while (maxIterations > 0) {
                    for (const phase of phaseFunctions) {
                        try {
                            JSON.parse(jsonString);
                            return jsonString;
                        } catch (error) {
                            jsonString = await phase(jsonString, error.message);
                        }
                    }
                    maxIterations--;
                }
                throw new Error("Unable to ensure valid JSON after all phases.");
            };

            // Get personality description
            this.logProgress("Fetching personality details...");
            this.logInfo(`Parameters received: ${JSON.stringify(this.parameters)}`);

            const personality = await personalityModule.getPersonality(this.spaceId, this.parameters.personality);
            if (!personality) {
                this.logError("Personality not found by ID");
                throw new Error('Personality not found by ID');
            }

            this.logInfo(`Found personality name: ${personality.name}`);
            const personalityObj = await personalityModule.getPersonalityByName(this.spaceId, personality.name);
            this.logInfo(`Personality object received: ${JSON.stringify(personalityObj)}`);

            if (!personalityObj) {
                this.logError("Personality not found by name");
                throw new Error('Personality not found by name');
            }
            this.logSuccess("Personality details fetched successfully");

            // Construct the analysis prompt
            this.logProgress("Constructing analysis prompt...");
            let analysisPrompt = `You are a bias detection expert. Analyze the following text for potential biases:

Personality: ${personalityObj.name}
Description: ${personalityObj.description}

User's Analysis Focus: ${this.parameters.prompt || 'Analyze the text for any potential biases'}

Text to analyze:
${this.parameters.text}

For each bias you identify:
1. Provide a pair of biases - one positive and one negative manifestation of the same bias type
2. For each pair:
   - Give the positive bias a score between (0,10) for both x and y coordinates
   - Give the negative bias the exact opposite coordinates (negative of the positive scores)
   - Example: If positive bias is {x: 7.5, y: 5.2}, its negative pair should be {x: -7.5, y: -5.2}
3. Distribute the bias pairs across different angles to create a fan-like pattern
4. Provide exactly ${this.parameters.topBiases} pairs of biases (${this.parameters.topBiases * 2} total points)
5. For each bias, explain how it manifests in the text

CRITICAL JSON FORMATTING REQUIREMENTS:
1. Your response MUST start with an opening curly brace {
2. Your response MUST end with a closing curly brace }
3. Use double quotes for all strings
4. Do not include any text, comments, or explanations outside the JSON structure
5. Ensure all JSON keys and values are properly quoted and formatted
6. Numbers should not be quoted
7. Follow this exact structure:

{
    "bias_pairs": [
        {
            "bias_type": "name of the bias type",
            "positive": {
                "name": "name of positive manifestation",
                "score": {"x": number, "y": number},
                "explanation": "how this manifests positively"
            },
            "negative": {
                "name": "name of negative manifestation",
                "score": {"x": number, "y": number},
                "explanation": "how this manifests negatively"
            }
        }
    ]
}

Ensure each pair of scores are exact opposites and distributed at different angles.`;

            // Get analysis from LLM with retries
            let retries = 3;
            let response;
            let result;

            const getLLMResponseWithTimeout = async (prompt, timeout = 20000) => {
                return Promise.race([
                    llmModule.generateText(this.spaceId, prompt, personalityObj.id),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('LLM request timed out')), timeout)
                    )
                ]);
            };

            while (retries > 0) {
                try {
                    this.logProgress(`Generating bias analysis (attempt ${4 - retries}/3)...`);

                    response = await getLLMResponseWithTimeout(analysisPrompt);
                    this.logInfo('Raw response:', response);

                    // First try to ensure we have valid JSON using our helper
                    const validJsonString = await ensureValidJson(
                        response.message,
                        3,  // Increase iterations to give more chances for correction
                        // Provide detailed JSON schema
                        `{
                            "type": "object",
                            "required": ["bias_pairs"],
                            "properties": {
                                "bias_pairs": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "required": ["bias_type", "positive", "negative"],
                                        "properties": {
                                            "bias_type": {"type": "string"},
                                            "positive": {
                                                "type": "object",
                                                "required": ["name", "score", "explanation"],
                                                "properties": {
                                                    "name": {"type": "string"},
                                                    "score": {
                                                        "type": "object",
                                                        "required": ["x", "y"],
                                                        "properties": {
                                                            "x": {"type": "number"},
                                                            "y": {"type": "number"}
                                                        }
                                                    },
                                                    "explanation": {"type": "string"}
                                                }
                                            },
                                            "negative": {
                                                "type": "object",
                                                "required": ["name", "score", "explanation"],
                                                "properties": {
                                                    "name": {"type": "string"},
                                                    "score": {
                                                        "type": "object",
                                                        "required": ["x", "y"],
                                                        "properties": {
                                                            "x": {"type": "number"},
                                                            "y": {"type": "number"}
                                                        }
                                                    },
                                                    "explanation": {"type": "string"}
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }`,
                        // Provide a complete example with proper string formatting
                        `{
                            "bias_pairs": [
                                {
                                    "bias_type": "confirmation_bias",
                                    "positive": {
                                        "name": "selective_perception",
                                        "score": {"x": 3, "y": 2},
                                        "explanation": "The text shows a tendency to focus on information that confirms existing beliefs."
                                    },
                                    "negative": {
                                        "name": "disconfirmation_bias",
                                        "score": {"x": -3, "y": -2},
                                        "explanation": "The text demonstrates resistance to information that challenges existing beliefs."
                                    }
                                }
                            ]
                        }`
                    );

                    // Parse the validated JSON
                    result = JSON.parse(validJsonString);
                    this.logInfo(`Parsed result for attempt ${4 - retries}:`, result);

                    // Validate result structure and lengths
                    if (!result.bias_pairs || !result.bias_pairs.length) {
                        throw new Error('Invalid response format: bias_pairs array is empty or missing');
                    }

                    // Check if we have exactly the number of pairs specified in topBiases
                    const expectedPairs = parseInt(this.parameters.topBiases);
                    if (result.bias_pairs.length !== expectedPairs) {
                        throw new Error(`Invalid response format: Expected exactly ${expectedPairs} bias pairs, got ${result.bias_pairs.length}`);
                    }

                    break;
                } catch (error) {
                    retries--;
                    const errorMessage = error.message || 'Unknown error';
                    this.logWarning(`Analysis generation failed: ${errorMessage}`);

                    if (retries === 0) {
                        this.logError(`Failed to generate valid analysis after all retries: ${errorMessage}`);
                        throw error;
                    }

                    // On retry, append error information to the prompt
                    analysisPrompt += `\n\nPrevious attempt failed with error: ${errorMessage}
                    Please ensure your response:
                    1. Is valid JSON that starts with { and ends with }
                    2. Contains exactly ${this.parameters.topBiases} items in bias_pairs
                    3. Uses double quotes for all strings
                    4. Does not include any text outside the JSON structure
                    5. Has properly formatted scores with x and y coordinates as numbers (not strings)
                    6. Follows the exact structure shown above
                    7. Has no trailing commas
                    8. Has no comments within the JSON`;

                    this.logWarning(`Retrying analysis (${retries}/3 attempts remaining)`);
                    // Wait 2 seconds before retrying
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            this.logSuccess("Successfully generated bias analysis");

            // Save analysis as a document
            this.logProgress("Saving analysis results...");

            const documentObj = {
                title: `bias_analysis_${new Date().toISOString()}`,
                type: 'bias_analysis',
                content: JSON.stringify(result, null, 2),
                abstract: JSON.stringify({
                    personality: personalityObj.name,
                    topBiases: this.parameters.topBiases,
                    timestamp: new Date().toISOString()
                }, null, 2),
                metadata: {
                    id: null,  // This will be filled by the system
                    title: `bias_analysis_${new Date().toISOString()}`
                }
            };
            
            const documentId = await documentModule.addDocument(this.spaceId, documentObj);

            // Add chapters and paragraphs for each bias
            this.logProgress("Adding chapters and paragraphs...");
            const chapterIds = [];

            // First, add the original text as the first chapter
            const textChapterData = {
                title: "Original Text",
                idea: "The text that was analyzed for biases"
            };
            const textChapterId = await documentModule.addChapter(this.spaceId, documentId, textChapterData);
            chapterIds.push(textChapterId);

            // Add the full text as a paragraph
            const textParagraphObj = {
                text: this.parameters.text,
                commands: {}
            };
            await documentModule.addParagraph(this.spaceId, documentId, textChapterId, textParagraphObj);
            this.logInfo("Added original text chapter");

            // Then add chapters for each bias
            for (let i = 0; i < result.bias_pairs.length; i++) {
                // Create chapter for each bias
                const chapterTitle = `${result.bias_pairs[i].bias_type} (Positive: ${JSON.stringify(result.bias_pairs[i].positive.score)}, Negative: ${JSON.stringify(result.bias_pairs[i].negative.score)})`;
                const chapterData = {
                    title: chapterTitle,
                    idea: `Analysis of ${result.bias_pairs[i].bias_type} bias with positive score ${JSON.stringify(result.bias_pairs[i].positive.score)} and negative score ${JSON.stringify(result.bias_pairs[i].negative.score)}`
                };

                const chapterId = await documentModule.addChapter(this.spaceId, documentId, chapterData);
                chapterIds.push(chapterId);
                this.logInfo(`Added chapter for bias: ${result.bias_pairs[i].bias_type}`, {
                    documentId: documentId,
                    chapterId: chapterId
                });

                // Add explanation as paragraph
                const paragraphObj = {
                    text: result.bias_pairs[i].positive.explanation,
                    commands: {}
                };

                const paragraphId = await documentModule.addParagraph(this.spaceId, documentId, chapterId, paragraphObj);
                this.logInfo(`Added paragraph for positive bias explanation`, {
                    documentId: documentId,
                    chapterId: chapterId,
                    paragraphId: paragraphId
                });

                // Add explanation as paragraph
                const negativeParagraphObj = {
                    text: result.bias_pairs[i].negative.explanation,
                    commands: {}
                };

                const negativeParagraphId = await documentModule.addParagraph(this.spaceId, documentId, chapterId, negativeParagraphObj);
                this.logInfo(`Added paragraph for negative bias explanation`, {
                    documentId: documentId,
                    chapterId: chapterId,
                    paragraphId: negativeParagraphId
                });
            }

            this.logSuccess("Successfully added all chapters and paragraphs");
            this.logSuccess(`Analysis saved as document with ID: ${documentId}`);

            return {
                status: 'completed',
                result: result,
                documentId: documentId
            };

        } catch (error) {
            this.logError(`Error in bias analysis: ${error.message}`);
            throw error;
        }
    },

    cancelTask: async function () {
        this.logWarning("Task cancelled by user");
    },

    serialize: async function () {
        return {
            taskType: 'BiasAnalysis',
            parameters: this.parameters
        };
    },

    getRelevantInfo: async function () {
        return {
            taskType: 'BiasAnalysis',
            parameters: this.parameters
        };
    }
}; 