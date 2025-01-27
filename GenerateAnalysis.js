module.exports = {
    runTask: async function () {
        try {
            // Configuration constants
            const MIN_LENGTH = 200;
            const MAX_LENGTH = 250;

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
1. Provide a general name for the bias type
2. Give a general, abstract explanation of how this type of bias typically manifests in writing
   - The explanation MUST be between ${MIN_LENGTH}-${MAX_LENGTH} characters long
   - Do not include specific references to the analyzed text
3. Provide ${this.parameters.topBiases} different biases

CRITICAL JSON FORMATTING REQUIREMENTS:
1. Your response MUST start with an opening curly brace {
2. Your response MUST end with a closing curly brace }
3. Use double quotes for all strings
4. Do not include any text, comments, or explanations outside the JSON structure
5. Ensure all JSON keys and values are properly quoted and formatted
6. Each explanation must be between ${MIN_LENGTH}-${MAX_LENGTH} characters
7. Follow this exact structure:

{
    "biases": [
        {
            "bias_type": "name of the bias type",
            "explanation": "general explanation of how this bias typically manifests in writing, without specific references to the analyzed text (${MIN_LENGTH}-${MAX_LENGTH} chars)"
        }
    ]
}`;

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
                            "required": ["biases"],
                            "properties": {
                                "biases": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "required": ["bias_type", "explanation"],
                                        "properties": {
                                            "bias_type": {"type": "string"},
                                            "explanation": {
                                                "type": "string",
                                                "minLength": ${MIN_LENGTH},
                                                "maxLength": ${MAX_LENGTH}
                                            }
                                        }
                                    }
                                }
                            }
                        }`,
                        // Provide a complete example with proper string formatting
                        `{
                            "biases": [
                                {
                                    "bias_type": "confirmation_bias",
                                    "explanation": "A cognitive tendency where individuals actively seek, interpret, and remember information that confirms their existing beliefs while dismissing contradictory evidence. This pattern often leads to reinforced preconceptions and resistance to alternative viewpoints."
                                }
                            ]
                        }`
                    );

                    // Parse the validated JSON
                    result = JSON.parse(validJsonString);
                    this.logInfo(`Parsed result for attempt ${4 - retries}:`, result);

                    // Validate result structure and lengths
                    if (!result.biases || !result.biases.length) {
                        throw new Error('Invalid response format: biases array is empty or missing');
                    }

                    // Check if we have at most the number of biases specified
                    const expectedBiases = parseInt(this.parameters.topBiases);
                    if (result.biases.length > expectedBiases) {
                        throw new Error(`Invalid response format: Got ${result.biases.length} biases, maximum allowed is ${expectedBiases}`);
                    }

                    // Log explanation lengths but don't enforce them
                    result.biases.forEach((bias, index) => {
                        const length = bias.explanation.length;
                        if (length < MIN_LENGTH || length > MAX_LENGTH) {
                            this.logWarning(`Note: Explanation for bias ${index + 1} has ${length} characters (suggested range was ${MIN_LENGTH}-${MAX_LENGTH} characters)`);
                        }
                    });

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
                    2. Contains exactly ${this.parameters.topBiases} items in biases array
                    3. Uses double quotes for all strings
                    4. Does not include any text outside the JSON structure
                    5. Has no trailing commas
                    6. Has no comments within the JSON`;

                    this.logWarning(`Retrying analysis (${retries}/3 attempts remaining)`);
                    // Wait 2 seconds before retrying
                    await new Promise(resolve => setTimeout(resolve, 6000));
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

            // Add chapters for each bias
            this.logProgress("Adding chapters and paragraphs...");
            const chapterIds = [];

            // Add chapters for each bias
            for (let i = 0; i < result.biases.length; i++) {
                // Create chapter for each bias
                const chapterData = {
                    title: result.biases[i].bias_type,
                    idea: `Analysis of ${result.biases[i].bias_type} bias`
                };

                const chapterId = await documentModule.addChapter(this.spaceId, documentId, chapterData);
                chapterIds.push(chapterId);
                this.logInfo(`Added chapter for bias: ${result.biases[i].bias_type}`, {
                    documentId: documentId,
                    chapterId: chapterId
                });

                // Add explanation as paragraph
                const paragraphObj = {
                    text: result.biases[i].explanation,
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