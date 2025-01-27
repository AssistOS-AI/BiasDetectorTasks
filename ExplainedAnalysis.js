module.exports = {
    runTask: async function () {
        try {
            // Configuration constants
            const MIN_SCORE = -10;
            const MAX_SCORE = 10;
            const MIN_WORDS = 450;
            const MAX_WORDS = 500;

            this.logInfo("Initializing bias explanation task...");
            const llmModule = await this.loadModule("llm");
            const personalityModule = await this.loadModule("personality");
            const documentModule = await this.loadModule("document");
            const spaceModule = await this.loadModule("space");

            // Get personality
            this.logProgress("Fetching personality details...");
            const personality = await personalityModule.getPersonality(this.spaceId, this.parameters.personality);
            if (!personality) {
                throw new Error('Personality not found by ID');
            }

            const personalityObj = await personalityModule.getPersonalityByName(this.spaceId, personality.name);
            if (!personalityObj) {
                throw new Error('Personality not found by name');
            }

            // Get source document
            const sourceDoc = await documentModule.getDocument(this.spaceId, this.parameters.sourceDocumentId);
            if (!sourceDoc) {
                throw new Error('Source document not found');
            }

            // Extract paragraphs and their biases from chapters
            let biasAnalyses = [];
            for (let i = 0; i < sourceDoc.chapters.length; i++) {
                const chapter = sourceDoc.chapters[i];
                if (chapter.paragraphs && chapter.paragraphs[0]) {
                    biasAnalyses.push({
                        bias_type: chapter.title,
                        text: chapter.paragraphs[0].text
                    });
                }
            }

            // Generate scores and explanations for each bias
            this.logProgress("Generating detailed explanations and scores...");
            let retries = 3;
            let response;
            let explanations;

            const getLLMResponseWithTimeout = async (prompt, timeout = 90000) => {
                return Promise.race([
                    llmModule.generateText(this.spaceId, prompt, personalityObj.id),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('LLM request timed out')), timeout)
                    )
                ]);
            };

            let explanationPrompt = `
            As ${personalityObj.name}, analyze each bias explanation and provide:
            1. A score from ${MIN_SCORE} to ${MAX_SCORE} indicating the strength and direction of the bias
            2. A detailed explanation (${MIN_WORDS}-${MAX_WORDS} words) of why this score was assigned

            For each bias, consider:
            - The significance of the bias in the context
            - The potential impact on readers or decision-making
            - The subtlety or obviousness of the bias
            - The broader implications of this type of bias

            Biases to analyze:
            ${JSON.stringify(biasAnalyses, null, 2)}

            CRITICAL JSON FORMATTING REQUIREMENTS:
            1. Your response MUST start with an opening curly brace {
            2. Your response MUST end with a closing curly brace }
            3. Use double quotes for all strings
            4. Do not include any text outside the JSON structure
            5. Do not use any special characters or line breaks within strings
            6. Each explanation must be a single, clean paragraph without repetition
            7. Do not use colons or special punctuation within the text
            8. Keep explanations focused and avoid repeating phrases
            9. Follow this exact structure:

            {
                "scored_biases": [
                    {
                        "bias_type": "name of bias from input",
                        "score": number between ${MIN_SCORE} and ${MAX_SCORE},
                        "detailed_explanation": "A single clean paragraph explaining the score"
                    }
                ]
            }`;

            while (retries > 0) {
                try {
                    this.logProgress(`Generating explanations (attempt ${4 - retries}/3)...`);
                    this.logInfo('Sending prompt to LLM:', explanationPrompt);

                    response = await getLLMResponseWithTimeout(explanationPrompt);
                    this.logInfo('Raw LLM response:', response);

                    try {
                        // Clean the response message before parsing
                        const cleanedMessage = response.message.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
                        explanations = JSON.parse(cleanedMessage);
                        this.logInfo('Successfully parsed explanations:', explanations);

                        // Validate the structure
                        if (!explanations.scored_biases || !Array.isArray(explanations.scored_biases)) {
                            throw new Error('Invalid response format: scored_biases array is missing or not an array');
                        }

                        if (explanations.scored_biases.length !== biasAnalyses.length) {
                            throw new Error(`Invalid response format: Expected ${biasAnalyses.length} explanations, got ${explanations.scored_biases.length}`);
                        }

                        // Validate each explanation
                        explanations.scored_biases.forEach((exp, idx) => {
                            if (!exp.bias_type || typeof exp.score !== 'number' || !exp.detailed_explanation) {
                                throw new Error(`Missing required fields in explanation ${idx + 1}`);
                            }
                            if (exp.score < MIN_SCORE || exp.score > MAX_SCORE) {
                                throw new Error(`Score must be between ${MIN_SCORE} and ${MAX_SCORE} in explanation ${idx + 1}`);
                            }
                            // Check for repetitive patterns in explanation
                            const repetitivePattern = /([\w\s]{20,})\1/;
                            if (repetitivePattern.test(exp.detailed_explanation)) {
                                throw new Error(`Explanation ${idx + 1} contains repetitive text patterns`);
                            }
                            // Log word count but don't enforce it
                            const wordCount = exp.detailed_explanation.split(/\s+/).length;
                            if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
                                this.logWarning(`Note: Explanation ${idx + 1} has ${wordCount} words (suggested range was ${MIN_WORDS}-${MAX_WORDS} words)`);
                            }
                        });

                        break;
                    } catch (parseError) {
                        this.logError('Failed to parse or validate LLM response:', parseError);
                        throw parseError;
                    }
                } catch (error) {
                    retries--;
                    const errorMessage = error.message || 'Unknown error';
                    this.logWarning(`Explanation generation failed: ${errorMessage}`);

                    if (retries === 0) {
                        this.logError(`Failed to generate valid explanation after all retries: ${errorMessage}`);
                        throw error;
                    }

                    explanationPrompt += `\n\nPrevious attempt failed with error: ${errorMessage}
                    Please ensure your response:
                    1. Is valid JSON
                    2. Contains exactly ${biasAnalyses.length} scored_biases
                    3. Each bias has a valid score between ${MIN_SCORE} and ${MAX_SCORE}
                    4. Each explanation is a single clean paragraph without repetition
                    5. No special characters or line breaks in text
                    6. No colons or complex punctuation in explanations`;

                    this.logWarning(`Retrying explanation generation (${retries}/3 attempts remaining)`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            // Create visualization data
            this.logProgress("Creating visualization data...");

            const width = 800;
            const height = 600;
            const padding = 60;

            // Load and create canvas
            const canvasModule = await this.loadModule("canvas");
            this.logInfo("Canvas module loaded");
            this.logInfo("Canvas module methods:", Object.keys(canvasModule));

            // Try different ways to create canvas
            let canvas;
            if (typeof canvasModule === 'function') {
                canvas = new canvasModule(width, height);
            } else if (canvasModule.createCanvas) {
                canvas = canvasModule.createCanvas(width, height);
            } else if (canvasModule.default) {
                canvas = new canvasModule.default(width, height);
            } else {
                throw new Error("No valid canvas creation method found. Available methods: " + Object.keys(canvasModule).join(", "));
            }

            const ctx = canvas.getContext('2d');

            // Set white background
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, width, height);

            // Draw axes
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 2;
            ctx.beginPath();
            // Horizontal axis
            ctx.moveTo(padding, height/2);
            ctx.lineTo(width - padding, height/2);
            // Vertical axis
            ctx.moveTo(width/2, padding);
            ctx.lineTo(width/2, height - padding);
            ctx.stroke();

            // Draw grid lines
            ctx.strokeStyle = 'rgba(0,0,0,0.1)';
            ctx.lineWidth = 1;
            for (let i = 0; i <= 10; i++) {
                const y = padding + i * (height - 2 * padding) / 10;
                ctx.beginPath();
                ctx.moveTo(padding, y);
                ctx.lineTo(width - padding, y);
                ctx.stroke();
            }

            // Add score labels
            ctx.fillStyle = 'black';
            ctx.font = '12px Arial';
            ctx.textAlign = 'right';
            for (let score = -10; score <= 10; score += 2) {
                const y = height/2 - score * (height - 2*padding)/20;
                ctx.fillText(score.toString(), width/2 - 10, y);
            }

            // Plot points
            ctx.fillStyle = 'rgb(54, 162, 235)';
            explanations.scored_biases.forEach((bias, index) => {
                const x = padding + (index + 1) * (width - 2*padding)/(explanations.scored_biases.length + 1);
                const y = height/2 - bias.score * (height - 2*padding)/20;

                // Draw point
                ctx.beginPath();
                ctx.arc(x, y, 6, 0, 2 * Math.PI);
                ctx.fill();

                // Add label
                ctx.save();
                ctx.translate(x, height - padding/2);
                ctx.rotate(-Math.PI/4);
                ctx.fillStyle = 'black';
                ctx.textAlign = 'right';
                ctx.fillText(bias.bias_type, 0, 0);
                ctx.restore();
            });

            // Convert canvas to buffer
            const buffer = canvas.toBuffer('image/png');
            this.logInfo("Canvas converted to PNG buffer successfully");

            // Save image using spaceModule
            const imageId = await spaceModule.putImage(buffer);
            this.logInfo("Image saved successfully with ID:", imageId);

            // Create and save the document
            this.logProgress("Creating document object...");
            const documentObj = {
                title: `bias_explained_${new Date().toISOString()}`,
                type: 'bias_explained',
                content: JSON.stringify({
                    explanations
                }, null, 2),
                abstract: JSON.stringify({
                    type: "bias_explained",
                    sourceDocumentId: this.parameters.sourceDocumentId,
                    personality: personalityObj.name,
                    timestamp: new Date().toISOString()
                }, null, 2),
                metadata: {
                    id: null,
                    title: `bias_explained_${new Date().toISOString()}`
                }
            };

            const documentId = await documentModule.addDocument(this.spaceId, documentObj);
            this.logInfo("Document created successfully with ID:", documentId);

            // Add visualization chapter first
            const visualChapter = {
                title: "Bias Score Distribution",
                idea: "Visual representation of bias scores"
            };
            const visualChapterId = await documentModule.addChapter(this.spaceId, documentId, visualChapter);
            this.logInfo("Visualization chapter added with ID:", visualChapterId);

            // Add visualization paragraph with image
            await documentModule.addParagraph(this.spaceId, documentId, visualChapterId, {
                text: "Distribution of bias scores from -10 to 10:",
                commands: {
                    image: {
                        id: imageId
                    }
                }
            });
            this.logInfo("Visualization paragraph added successfully");

            // Add score summary
            await documentModule.addParagraph(this.spaceId, documentId, visualChapterId, {
                text: explanations.scored_biases.map(bias =>
                    `${bias.bias_type}: ${bias.score}`
                ).join('\n'),
                commands: {}
            });

            // Add detailed chapters for each bias
            this.logProgress("Adding detailed bias chapters...");
            for (const bias of explanations.scored_biases) {
                const chapterData = {
                    title: bias.bias_type,
                    idea: `Analysis of ${bias.bias_type} (Score: ${bias.score})`
                };

                const chapterId = await documentModule.addChapter(this.spaceId, documentId, chapterData);
                await documentModule.addParagraph(this.spaceId, documentId, chapterId, {
                    text: bias.detailed_explanation,
                    commands: {}
                });
                this.logInfo(`Added chapter for bias: ${bias.bias_type}`);
            }

            this.logProgress("Task completed successfully!");
            this.logInfo("Document saved and accessible at ID:", documentId);

            return {
                status: 'completed',
                documentId: documentId
            };

        } catch (error) {
            this.logError(`Error in bias explanation: ${error.message}`);
            throw error;
        }
    },

    cancelTask: async function () {
        this.logWarning("Task cancelled by user");
    },

    serialize: async function () {
        return {
            taskType: 'ExplainedAnalysis',
            parameters: this.parameters
        };
    },

    getRelevantInfo: async function () {
        return {
            taskType: 'ExplainedAnalysis',
            parameters: this.parameters
        };
    }
}; 