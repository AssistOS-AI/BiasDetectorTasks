module.exports = {
    runTask: async function () {
        try {
            const llmModule = await this.loadModule("llm");
            const personalityModule = await this.loadModule("personality");
            const utilModule = await this.loadModule("util");

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
            const personalityObj = await personalityModule.getPersonalityByName(this.spaceId, this.parameters.personality);
            if (!personalityObj) {
                throw new Error('Personality not found');
            }

            // Construct the analysis prompt
            const analysisPrompt = `You are analyzing this text with the following personality and context:

Personality: ${this.parameters.personality}
Description: ${personalityObj.description}

User's Analysis Focus: ${this.parameters.prompt || 'Analyze the text for any potential biases'}

Text to analyze:
${this.parameters.text}

IMPORTANT:
- Return exactly ${this.parameters.topBiases} most significant biases
- For each bias, provide a score between -10 and 10
- Negative scores indicate negative bias, positive scores indicate positive bias
- Provide a detailed explanation for each bias
- Format your response in JSON with this exact structure:
{
    "biases": ["bias_name_1", "bias_name_2", ...],
    "scores": [score1, score2, ...],
    "explanations": ["explanation1", "explanation2", ...]
}`;

            // Get analysis from LLM with retries
            let retries = 3;
            let response;
            let result;

            while (retries > 0) {
                try {
                    this.logProgress("Generating bias analysis...");
                    response = await llmModule.generateText(this.spaceId, analysisPrompt, this.parameters.personality);
                    
                    // Validate JSON structure
                    const jsonSchema = `{
                        "biases": ["string"],
                        "scores": [number],
                        "explanations": ["string"]
                    }`;
                    const correctExample = `{
                        "biases": ["gender_bias", "age_bias"],
                        "scores": [-5, 3],
                        "explanations": ["Shows preference towards male perspectives", "Favors younger viewpoints"]
                    }`;

                    const jsonString = await ensureValidJson(response.message, 3, jsonSchema, correctExample);
                    result = JSON.parse(jsonString);

                    // Validate result structure
                    if (!result.biases || !result.scores || !result.explanations ||
                        result.biases.length !== parseInt(this.parameters.topBiases) ||
                        result.scores.length !== parseInt(this.parameters.topBiases) ||
                        result.explanations.length !== parseInt(this.parameters.topBiases)) {
                        throw new Error('Invalid response format from LLM');
                    }

                    break;
                } catch (error) {
                    retries--;
                    if (retries === 0) {
                        throw new Error(`Failed to generate valid analysis after all retries: ${error.message}`);
                    }
                    this.logWarning(`Retry attempt for bias analysis: ${3 - retries}/3`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            this.logSuccess("Successfully generated bias analysis");
            return {
                status: 'completed',
                result: result
            };

        } catch (error) {
            this.logError(`Error in bias analysis: ${error.message}`);
            throw error;
        }
    },

    cancelTask: async function () {
        // Implement cancellation logic if needed
    },

    serialize: async function () {
        // Implement serialization if needed
    },

    getRelevantInfo: async function () {
        // Return any relevant task information
        return {
            taskType: 'BiasAnalysis',
            parameters: this.parameters
        };
    }
}; 