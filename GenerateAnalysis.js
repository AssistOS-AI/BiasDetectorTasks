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
                        this.logInfo(`LLM helper using personality: ${this.parameters.personality}`);
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

            // Add sanitization helper
            const sanitizeResponse = (text) => {
                return text
                    .replace(/[^\x00-\x7F]/g, '') // Remove non-ASCII characters
                    .replace(/[_]/g, ' ') // Replace underscores with spaces
                    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
                    .replace(/،/g, ',') // Replace Arabic comma with standard comma
                    .replace(/[^\w\s,.!?()-]/g, '') // Keep only basic punctuation and alphanumeric chars
                    .trim();
            };

            // Add detokenize helper
            const detokenize = text => Object.values(text).join('');

            // Get personality description
            this.logProgress("Fetching personality details...");
            this.logInfo(`Parameters received: ${JSON.stringify(this.parameters)}`);
            this.logInfo(`Attempting to fetch personality with ID: ${this.parameters.personality}`);

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
            const analysisPrompt = `You are analyzing this text with the following personality and context:

Personality: ${personalityObj.name}
Description: ${personalityObj.description}

User's Analysis Focus: ${this.parameters.prompt || 'Analyze the text for any potential biases'}

Text to analyze:
${this.parameters.text}

IMPORTANT - READ CAREFULLY:
- DO NOT include any introductory text or commentary
- START YOUR RESPONSE DIRECTLY with the JSON object
- DO NOT include any text after the JSON object
- Return exactly ${this.parameters.topBiases} most significant biases
- For each bias, provide a score between -10 and 10
- Negative scores indicate negative bias, positive scores indicate positive bias
- Provide a detailed explanation for each bias (200-250 characters long)
- DO NOT include the score in the explanation text
- Use ONLY English language and standard ASCII characters
- DO NOT use special characters, emojis, or non-English text
- Use only basic punctuation (periods, commas, spaces, parentheses)
- Your response MUST be a valid JSON object with this EXACT structure:

{
    "biases": [
        "first_bias_name",
        "second_bias_name",
        "third_bias_name"
    ],
    "scores": [
        -7,
        5,
        3
    ],
    "explanations": [
        "First bias explanation that is between 200-250 characters long without including the score.",
        "Second bias explanation that is between 200-250 characters long without including the score.",
        "Third bias explanation that is between 200-250 characters long without including the score."
    ]
}

REMEMBER: Start your response with { and end with } - no other text allowed.`;

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
                    const cleanResponse = detokenize(response.message);
                    this.logInfo(`Raw LLM response for attempt ${4 - retries}:`, cleanResponse);

                    // Parse the response directly as JSON
                    result = JSON.parse(cleanResponse);
                    this.logInfo(`Parsed result for attempt ${4 - retries}:`, result);

                    // Validate result structure and lengths
                    if (!result.biases || !result.scores || !result.explanations ||
                        result.biases.length !== parseInt(this.parameters.topBiases) ||
                        result.scores.length !== parseInt(this.parameters.topBiases) ||
                        result.explanations.length !== parseInt(this.parameters.topBiases)) {
                        throw new Error('Invalid response format: array lengths do not match topBiases');
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
                    prompt: this.parameters.prompt,
                    topBiases: this.parameters.topBiases,
                    text: this.parameters.text.substring(0, 100) + "...",
                    timestamp: new Date().toISOString()
                }, null, 2),
                metadata: {
                    id: null,  // This will be filled by the system
                    title: `bias_analysis_${new Date().toISOString()}`
                }
            };
            
            const documentId = await documentModule.addDocument(this.spaceId, documentObj);

            // Add chapters and paragraphs for each bias
            this.logProgress("Adding chapters and paragraphs for each bias...");
            const chapterIds = [];

            for (let i = 0; i < result.biases.length; i++) {
                // Create chapter for each bias
                const chapterTitle = `${result.biases[i]} (Score: ${result.scores[i]})`;
                const chapterData = {
                    title: chapterTitle,
                    idea: `Analysis of ${result.biases[i]} bias with score ${result.scores[i]}`
                };

                const chapterId = await documentModule.addChapter(this.spaceId, documentId, chapterData);
                chapterIds.push(chapterId);
                this.logInfo(`Added chapter for bias: ${result.biases[i]}`, {
                    documentId: documentId,
                    chapterId: chapterId
                });

                // Add explanation as paragraph
                const paragraphObj = {
                    text: result.explanations[i],
                    commands: {}
                };

                const paragraphId = await documentModule.addParagraph(this.spaceId, documentId, chapterId, paragraphObj);
                this.logInfo(`Added paragraph for bias explanation`, {
                    documentId: documentId,
                    chapterId: chapterId,
                    paragraphId: paragraphId
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