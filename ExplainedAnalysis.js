module.exports = {
    runTask: async function () {
        try {
            // Configuration constants
            const MIN_SCORE = 0;
            const MAX_SCORE = 10;
            const MIN_WORDS = 50;
            const MAX_WORDS = 100;

            this.logInfo("Initializing bias explanation task...");
            const llmModule = await this.loadModule("llm");
            const personalityModule = await this.loadModule("personality");
            const documentModule = await this.loadModule("document");
            const spaceModule = await this.loadModule("space");

            // Validate and parse personality IDs
            this.logProgress("Validating personality parameters...");
            if (!this.parameters.personalities) {
                throw new Error('No personalities provided');
            }

            this.logInfo("Raw parameters:", {
                type: typeof this.parameters.personalities,
                value: this.parameters.personalities
            });

            let personalityIds;
            if (typeof this.parameters.personalities === 'string') {
                // Try to split by comma first
                if (this.parameters.personalities.includes(',')) {
                    personalityIds = this.parameters.personalities.split(',').map(id => id.trim());
                    this.logInfo("Split by comma into:", personalityIds);
                } else {
                    // If no comma, check if it's a concatenated string that needs to be split
                    this.logInfo("Raw personality string:", this.parameters.personalities);
                    // Split the string into chunks of 16 characters (assuming each ID is 16 chars)
                    personalityIds = this.parameters.personalities.match(/.{16}/g) || [this.parameters.personalities];
                    this.logInfo("Split into 16-char chunks:", personalityIds);
                }
            } else if (Array.isArray(this.parameters.personalities)) {
                personalityIds = this.parameters.personalities;
                this.logInfo("Using array directly:", personalityIds);
            } else {
                throw new Error('Invalid personalities parameter format');
            }

            this.logInfo("Final parsed personality IDs:", personalityIds);

            // Get personalities
            this.logProgress("Fetching personality details...");
            const personalities = await Promise.all(
                personalityIds.map(async (personalityId) => {
                    const personality = await personalityModule.getPersonality(this.spaceId, personalityId);
                    if (!personality) {
                        throw new Error(`Personality not found by ID: ${personalityId}`);
                    }
                    const personalityObj = await personalityModule.getPersonalityByName(this.spaceId, personality.name);
                    if (!personalityObj) {
                        throw new Error(`Personality not found by name: ${personality.name}`);
                    }
                    return personalityObj;
                })
            );

            this.logInfo("Successfully loaded personalities:", personalities.map(p => p.name));

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

            // Generate scores and explanations for each personality
            let allPersonalityExplanations = [];

            for (const personality of personalities) {
                this.logProgress(`Generating analysis for personality: ${personality.name}...`);

                let retries = 3;
                let explanations;

                let explanationPrompt = `
                As ${personality.name} (${personality.description}), analyze each bias explanation and provide:
                1. Two scores from ${MIN_SCORE} to ${MAX_SCORE}:
                   - A score indicating your level of support or agreement with this bias
                   - A score indicating your level of opposition or disagreement with this bias
                2. A detailed explanation (${MIN_WORDS}-${MAX_WORDS} words) of why you assigned these scores

                For each bias, consider:
                - The significance of the bias in the context
                - The potential impact on readers or decision-making
                - The subtlety or obviousness of the bias
                - The broader implications of this type of bias

                You MUST analyze ALL ${biasAnalyses.length} biases provided below.
                Each bias MUST have both scores.

                Biases to analyze (${biasAnalyses.length} total):
                ${JSON.stringify(biasAnalyses, null, 2)}

                CRITICAL JSON FORMATTING REQUIREMENTS:
                1. Your response MUST be PURE JSON - no markdown, no backticks, no extra text
                2. You MUST analyze exactly ${biasAnalyses.length} biases, no more, no less
                3. Each bias MUST have both for_score and against_score
                4. Keep explanations concise (${MIN_WORDS}-${MAX_WORDS} words) to avoid truncation
                5. Follow this exact structure and DO NOT deviate from it:
                
                [
                    {
                        "bias_type": "name of bias from input",
                        "for_score": number between ${MIN_SCORE} and ${MAX_SCORE},
                        "against_score": number between ${MIN_SCORE} and ${MAX_SCORE},
                        "detailed_explanation": "A single concise paragraph explaining your perspective"
                    }
                ]

                STRICT JSON REQUIREMENTS:
                - Response MUST start with [ and end with ]
                - Use double quotes (") for all strings
                - No single quotes (')
                - No trailing commas
                - No comments
                - No line breaks within strings
                - No extra fields or properties
                - No markdown formatting or code blocks
                - ONLY pure, valid JSON array

                IMPORTANT: 
                - Analyze each bias from YOUR unique personality perspective
                - Keep explanations between ${MIN_WORDS} and ${MAX_WORDS} words
                - Ensure your scores and explanations reflect your distinct personality traits and viewpoints
                - Make your analysis clearly different from how other personalities might view these biases
                - Base your responses on your specific personality characteristics and background`;

                const getLLMResponseWithTimeout = async (prompt, timeout = 90000) => {
                    return Promise.race([
                        llmModule.generateText(this.spaceId, prompt, personality.id),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('LLM request timed out')), timeout)
                        )
                    ]);
                };

                while (retries > 0) {
                    try {
                        this.logProgress(`Generating explanations (attempt ${4 - retries}/3)...`);
                        this.logInfo('Sending prompt to LLM:', explanationPrompt);

                        const response = await getLLMResponseWithTimeout(explanationPrompt);
                        this.logInfo('Raw LLM response:', response);

                        try {
                            // Use response.message directly without cleaning
                            let cleanedMessage = response.message;
                            this.logInfo('Message before parsing:', cleanedMessage);

                            try {
                                explanations = JSON.parse(cleanedMessage);
                                // Convert the array response to the expected structure
                                if (Array.isArray(explanations)) {
                                    explanations = { scored_biases: explanations };
                                }
                            } catch (parseError) {
                                this.logError('JSON parse error:', parseError);
                                throw new Error(`Invalid JSON format: ${parseError.message}`);
                            }

                            this.logInfo('Parsed explanations structure:', {
                                has_scored_biases: !!explanations.scored_biases,
                                is_array: Array.isArray(explanations.scored_biases),
                                length: explanations.scored_biases?.length,
                                expected_length: biasAnalyses.length
                            });

                            // Validate the structure
                            if (!explanations.scored_biases || !Array.isArray(explanations.scored_biases)) {
                                throw new Error('Invalid response format: scored_biases array is missing or not an array');
                            }

                            if (explanations.scored_biases.length !== biasAnalyses.length) {
                                throw new Error(`Invalid response format: Expected ${biasAnalyses.length} explanations, got ${explanations.scored_biases.length}`);
                            }

                            // Validate each explanation
                            explanations.scored_biases.forEach((exp, idx) => {
                                const missingFields = [];
                                if (!exp.bias_type) missingFields.push('bias_type');
                                if (typeof exp.for_score !== 'number') missingFields.push('for_score');
                                if (typeof exp.against_score !== 'number') missingFields.push('against_score');
                                if (!exp.detailed_explanation) missingFields.push('detailed_explanation');

                                if (missingFields.length > 0) {
                                    throw new Error(`Missing or invalid fields in explanation ${idx + 1}: ${missingFields.join(', ')}`);
                                }

                                if (exp.for_score < MIN_SCORE || exp.for_score > MAX_SCORE ||
                                    exp.against_score < MIN_SCORE || exp.against_score > MAX_SCORE) {
                                    throw new Error(`Scores must be between ${MIN_SCORE} and ${MAX_SCORE} in explanation ${idx + 1}`);
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

                        // Add more context to the retry prompt
                        explanationPrompt += `\n\nPrevious attempt failed with error: ${errorMessage}
                        Please ensure your response:
                        1. Is valid JSON
                        2. Contains EXACTLY ${biasAnalyses.length} scored_biases (you provided wrong number)
                        3. Each bias has both for_score and against_score between ${MIN_SCORE} and ${MAX_SCORE}
                        4. Each explanation is a single clean paragraph
                        5. No special characters or line breaks in text
                        6. Each bias from the input is analyzed`;

                        this.logWarning(`Retrying explanation generation (${retries}/3 attempts remaining)`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }

                explanations.personality = personality.name;
                allPersonalityExplanations.push(explanations);
            }

            // Create visualization data
            this.logProgress("Creating visualization data...");

            const width = 1000;
            const height = 800;
            const padding = 100;
            const centerX = width / 2;

            // Load canvas using require
            const { createCanvas } = require('canvas');
            const canvas = createCanvas(width, height);
            const ctx = canvas.getContext('2d');

            // Set white background
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, width, height);

            // Draw central vertical axis
            ctx.strokeStyle = 'rgba(0,0,0,0.5)';  // 50% opacity black
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(centerX, padding);
            ctx.lineTo(centerX, height - padding);
            ctx.stroke();

            // Draw grid lines and score labels
            ctx.strokeStyle = 'rgba(0,0,0,0.1)';
            ctx.lineWidth = 1;
            ctx.fillStyle = 'black';
            ctx.font = '12px Arial';

            for (let score = MAX_SCORE; score >= 0; score -= 1) {
                const y = padding + (MAX_SCORE - score) * (height - 2 * padding) / MAX_SCORE;

                // Grid lines
                ctx.beginPath();
                ctx.moveTo(padding, y);
                ctx.lineTo(width - padding, y);
                ctx.stroke();

                // Score labels
                ctx.textAlign = 'right';
                ctx.fillText(score.toString(), centerX - 5, y + 4);
            }

            // Plot points for each personality with different colors
            const colors = ['rgb(54, 162, 235)', 'rgb(255, 99, 132)', 'rgb(75, 192, 192)'];
            const legendY = padding;
            const legendX = width - padding - 100;

            // Draw legend
            ctx.font = '14px Arial';
            ctx.textAlign = 'left';
            ctx.fillStyle = 'black';
            ctx.fillText('Personalities:', legendX, legendY - 20);

            allPersonalityExplanations.forEach((personalityData, pIndex) => {
                const color = colors[pIndex % colors.length];

                // Add to legend
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(legendX, legendY + (pIndex * 25), 6, 0, 2 * Math.PI);
                ctx.fill();
                ctx.fillText(personalityData.personality, legendX + 15, legendY + (pIndex * 25) + 4);

                // Plot points
                personalityData.scored_biases.forEach((bias, bIndex) => {
                    const y = padding + (MAX_SCORE - bias.score) * (height - 2 * padding) / MAX_SCORE;
                    const baseY = padding + (MAX_SCORE - bias.for_score) * (height - 2 * padding) / MAX_SCORE;

                    // Calculate halfway points between center and edges
                    const distanceFromCenter = (centerX - padding) / 2;  // Half the distance from center to edge

                    // Against score (left side)
                    const leftX = centerX - distanceFromCenter - (pIndex * 20);
                    const leftY = padding + (MAX_SCORE - bias.against_score) * (height - 2 * padding) / MAX_SCORE;

                    // For score (right side)
                    const rightX = centerX + distanceFromCenter + (pIndex * 20);
                    const rightY = padding + (MAX_SCORE - bias.for_score) * (height - 2 * padding) / MAX_SCORE;

                    // Draw connecting line
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(leftX, leftY);
                    ctx.lineTo(rightX, rightY);
                    ctx.stroke();

                    // Draw points
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(leftX, leftY, 6, 0, 2 * Math.PI);
                    ctx.fill();

                    ctx.beginPath();
                    ctx.arc(rightX, rightY, 6, 0, 2 * Math.PI);
                    ctx.fill();
                });
            });

            // Add labels
            ctx.font = '14px Arial';
            ctx.textAlign = 'center';
            ctx.fillStyle = 'black';
            ctx.fillText('Against Bias', centerX - 150, padding - 20);
            ctx.fillText('For Bias', centerX + 150, padding - 20);

            // Convert canvas to buffer
            const buffer = canvas.toBuffer('image/png');
            const imageId = await spaceModule.putImage(buffer);

            // Create and save the document
            this.logProgress("Creating document object...");
            const documentObj = {
                title: `bias_explained_${new Date().toISOString()}`,
                type: 'bias_explained',
                content: JSON.stringify({
                    allPersonalityExplanations
                }, null, 2),
                abstract: JSON.stringify({
                    type: "bias_explained",
                    sourceDocumentId: this.parameters.sourceDocumentId,
                    personalities: personalities.map(p => p.name),
                    timestamp: new Date().toISOString()
                }, null, 2),
                metadata: {
                    id: null,
                    title: `bias_explained_${new Date().toISOString()}`
                }
            };

            const documentId = await documentModule.addDocument(this.spaceId, documentObj);

            // Add visualization chapter
            const visualChapter = {
                title: "Bias Score Distribution",
                idea: "Visual representation of bias scores across personalities"
            };
            const visualChapterId = await documentModule.addChapter(this.spaceId, documentId, visualChapter);

            await documentModule.addParagraph(this.spaceId, documentId, visualChapterId, {
                text: "",
                commands: {
                    image: {
                        id: imageId
                    }
                }
            });

            // Add chapters for each bias and personality
            for (const personalityExplanation of allPersonalityExplanations) {
                for (const bias of personalityExplanation.scored_biases) {
                    const chapterData = {
                        title: `${bias.bias_type} - ${personalityExplanation.personality} (For: ${bias.for_score}, Against: ${bias.against_score})`,
                        idea: `Analysis of ${bias.bias_type} by ${personalityExplanation.personality}`
                    };

                    const chapterId = await documentModule.addChapter(this.spaceId, documentId, chapterData);
                    await documentModule.addParagraph(this.spaceId, documentId, chapterId, {
                        text: bias.detailed_explanation,
                        commands: {}
                    });
                }
            }

            this.logProgress("Task completed successfully!");
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