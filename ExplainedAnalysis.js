module.exports = {
    runTask: async function () {
        try {
            // Configuration constants
            const MIN_SCORE = 0;
            const MAX_SCORE = 10;
            const MIN_WORDS = 50;
            const MAX_WORDS = 100;

            // Define colors for personalities
            const colors = ['rgb(54, 162, 235)', 'rgb(255, 99, 132)', 'rgb(75, 192, 192)'];

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

            // =============================================
            // FIRST DIAGRAM: Bias Analysis Distribution
            // Circular visualization with bias types and scores
            // =============================================

            // Create visualization data
            this.logProgress("Creating visualization data...");

            const width = 6750;
            const height = 2400;
            const padding = 450;
            const centerX = width / 2;

            // Load canvas using require
            const { createCanvas } = require('canvas');
            const canvas = createCanvas(width, height);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, width, height);

            // Draw title
            ctx.font = 'bold 120px Arial';
            ctx.textAlign = 'center';
            ctx.fillStyle = 'black';
            ctx.fillText('Bias Analysis Distribution', width/2, padding/2);

            // Create circular visualization
            const circularCenterX = width / 2;
            const baseHeight = height / 2; // Use this for radius calculation
            const circularCenterY = baseHeight + 150; // Use this for position
            const radius = (Math.min(circularCenterX, baseHeight) - padding) * 1.3;

            // Draw concentric circles
            for (let i = 1; i <= 10; i++) {
                ctx.beginPath();
                ctx.arc(circularCenterX, circularCenterY, (i / 10) * radius, 0, Math.PI * 2);
                ctx.strokeStyle = i === 10 ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.1)';
                ctx.lineWidth = i === 10 ? 2 : 1;
                ctx.stroke();
            }

            // Draw center point
            ctx.beginPath();
            ctx.arc(circularCenterX, circularCenterY, 5, 0, Math.PI * 2);
            ctx.fillStyle = 'black';
            ctx.fill();

            // Calculate angles for bias lines
            const biasTypes = [...new Set(allPersonalityExplanations[0].scored_biases.map(b => b.bias_type))];
            const angleStep = Math.PI / biasTypes.length; // Divide by number of biases

            // Draw bias lines and points
            biasTypes.forEach((biasType, index) => {
                const angle = index * angleStep * 2; // Multiply by 2 to space evenly
                const color = `hsl(${(360 / biasTypes.length) * index}, 70%, 50%)`;

                // Find all bias scores for this bias type
                const biasScores = allPersonalityExplanations.flatMap(p => {
                    const bias = p.scored_biases.find(b => b.bias_type === biasType);
                    return bias ? [bias.against_score, bias.for_score] : [];
                });

                if (biasScores.length > 0) {
                    // Draw points and connecting lines for each personality
                    allPersonalityExplanations.forEach((personality, pIndex) => {
                        const bias = personality.scored_biases.find(b => b.bias_type === biasType);
                        if (bias) {
                            const shapes = ['circle', 'triangle', 'square', 'diamond', 'pentagon', 'hexagon', 'star', 'cross', 'heart', 'octagon'];
                            const shape = shapes[pIndex % shapes.length];

                            // Calculate against score point
                            const againstDist = (bias.against_score / 10) * radius;
                            const againstX = circularCenterX + againstDist * Math.cos(angle);
                            const againstY = circularCenterY + againstDist * Math.sin(angle);

                            // Calculate for score point on opposite side
                            const forDist = (bias.for_score / 10) * radius;
                            const forX = circularCenterX + forDist * Math.cos(angle + Math.PI);
                            const forY = circularCenterY + forDist * Math.sin(angle + Math.PI);

                            // Draw points first
                            ctx.fillStyle = colors[pIndex];
                            drawShape(ctx, shape, againstX, againstY, 70, bias.against_score);
                            drawShape(ctx, shape, forX, forY, 70, bias.for_score);

                            // Then draw connecting line between the points
                            ctx.strokeStyle = colors[pIndex];
                            ctx.lineWidth = 7;
                            ctx.globalAlpha = 0.5;
                            ctx.beginPath();
                            ctx.moveTo(againstX, againstY);
                            ctx.lineTo(forX, forY);
                            ctx.stroke();
                            ctx.globalAlpha = 1;
                        }
                    });
                }
            });

            // Draw legends on the right side
            const legendStartX = width - padding * 4; // Moved further right
            const legendStartY = padding * 2;
            const legendSpacing = 100;

            // Draw personality legend
            ctx.font = 'bold 60px Arial';
            ctx.textAlign = 'left';
            ctx.fillStyle = 'black';
            ctx.fillText('Personalities:', legendStartX, legendStartY - legendSpacing);

            // Draw personality shapes and names
            ctx.font = 'bold 48px Arial';
            allPersonalityExplanations.forEach((personality, index) => {
                const y = legendStartY + index * legendSpacing;
                const shapes = ['circle', 'triangle', 'square', 'diamond', 'pentagon', 'hexagon', 'star', 'cross', 'heart', 'octagon'];
                const shape = shapes[index % shapes.length];

                // Draw shape example
                ctx.fillStyle = colors[index];
                ctx.strokeStyle = colors[index];
                drawShape(ctx, shape, legendStartX + 40, y - 10, 25, '');

                // Draw personality name
                ctx.fillStyle = 'black';
                ctx.fillText(personality.personality, legendStartX + 100, y);
            });

            // Draw bias type legend
            const biasLegendStartY = legendStartY + (allPersonalityExplanations.length + 2) * legendSpacing;
            ctx.font = 'bold 60px Arial';
            ctx.fillStyle = 'black';
            ctx.fillText('Bias Types:', legendStartX, biasLegendStartY - legendSpacing);

            // Draw bias types and colors
            ctx.font = 'bold 48px Arial';
            biasTypes.forEach((biasType, index) => {
                const y = biasLegendStartY + index * legendSpacing;
                const color = `hsl(${(360 / biasTypes.length) * index}, 70%, 50%)`;

                // Draw color line
                ctx.strokeStyle = color;
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.moveTo(legendStartX, y - 10);
                ctx.lineTo(legendStartX + 80, y - 10);
                ctx.stroke();

                // Draw bias type name with scores
                ctx.fillStyle = 'black';
                const scores = allPersonalityExplanations.map(personality => {
                    const bias = personality.scored_biases.find(b => b.bias_type === biasType);
                    if (bias) {
                        return `${bias.against_score}, ${bias.for_score}`;
                    }
                    return '';
                }).filter(Boolean);
                ctx.fillText(`${biasType} (${scores.join('; ')})`, legendStartX + 100, y);
            });

            // Helper function to draw different shapes
            function drawShape(ctx, shape, x, y, size, score) {
                switch(shape) {
                    case 'circle':
                        ctx.beginPath();
                        ctx.arc(x, y, size/2, 0, Math.PI * 2);
                        ctx.fill();
                        break;
                    case 'triangle':
                        ctx.beginPath();
                        const height = size * Math.sqrt(3) / 2;
                        ctx.moveTo(x, y - height/2);
                        ctx.lineTo(x - size/2, y + height/2);
                        ctx.lineTo(x + size/2, y + height/2);
                        ctx.closePath();
                        ctx.fill();
                        break;
                    case 'square':
                        ctx.beginPath();
                        ctx.rect(x - size/2, y - size/2, size, size);
                        ctx.fill();
                        break;
                    case 'diamond':
                        ctx.beginPath();
                        ctx.moveTo(x, y - size/2);
                        ctx.lineTo(x + size/2, y);
                        ctx.lineTo(x, y + size/2);
                        ctx.lineTo(x - size/2, y);
                        ctx.closePath();
                        ctx.fill();
                        break;
                    case 'pentagon':
                        ctx.beginPath();
                        for (let i = 0; i < 5; i++) {
                            const angle = (i * 2 * Math.PI / 5) - Math.PI / 2;
                            const px = x + size/2 * Math.cos(angle);
                            const py = y + size/2 * Math.sin(angle);
                            if (i === 0) ctx.moveTo(px, py);
                            else ctx.lineTo(px, py);
                        }
                        ctx.closePath();
                        ctx.fill();
                        break;
                    case 'hexagon':
                        ctx.beginPath();
                        for (let i = 0; i < 6; i++) {
                            const angle = (i * 2 * Math.PI / 6);
                            const px = x + size/2 * Math.cos(angle);
                            const py = y + size/2 * Math.sin(angle);
                            if (i === 0) ctx.moveTo(px, py);
                            else ctx.lineTo(px, py);
                        }
                        ctx.closePath();
                        ctx.fill();
                        break;
                    case 'star':
                        ctx.beginPath();
                        for (let i = 0; i < 10; i++) {
                            const angle = (i * 2 * Math.PI / 10) - Math.PI / 2;
                            const r = i % 2 === 0 ? size/2 : size/4;
                            const px = x + r * Math.cos(angle);
                            const py = y + r * Math.sin(angle);
                            if (i === 0) ctx.moveTo(px, py);
                            else ctx.lineTo(px, py);
                        }
                        ctx.closePath();
                        ctx.fill();
                        break;
                    case 'cross':
                        ctx.beginPath();
                        ctx.moveTo(x - size/2, y);
                        ctx.lineTo(x + size/2, y);
                        ctx.moveTo(x, y - size/2);
                        ctx.lineTo(x, y + size/2);
                        ctx.lineWidth = size/4;
                        ctx.stroke();
                        break;
                    case 'heart':
                        ctx.beginPath();
                        const topCurveHeight = size/3;
                        ctx.moveTo(x, y + size/4);
                        ctx.bezierCurveTo(x + size/2, y - size/2, x + size, y, x, y + size/2);
                        ctx.bezierCurveTo(x - size, y, x - size/2, y - size/2, x, y + size/4);
                        ctx.fill();
                        break;
                    case 'octagon':
                        ctx.beginPath();
                        for (let i = 0; i < 8; i++) {
                            const angle = (i * 2 * Math.PI / 8);
                            const px = x + size/2 * Math.cos(angle);
                            const py = y + size/2 * Math.sin(angle);
                            if (i === 0) ctx.moveTo(px, py);
                            else ctx.lineTo(px, py);
                        }
                        ctx.closePath();
                        ctx.fill();
                        break;
                }

                // Draw score inside shape
                if (score !== undefined && score !== null && score !== '') {
                    ctx.fillStyle = 'white';
                    ctx.font = 'bold 48px Arial';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(score.toString(), x, y);
                }
            }

            // =============================================
            // SECOND DIAGRAM: Bias Strength Comparison
            // Bar chart showing bias strength comparison
            // =============================================

            // Create a second canvas for bias strength comparison
            const strengthCanvas = createCanvas(width, height);
            const strengthCtx = strengthCanvas.getContext('2d');

            // Set white background
            strengthCtx.fillStyle = 'white';
            strengthCtx.fillRect(0, 0, width, height);

            // Calculate the center line position
            const centerLineX = width/2;
            const scaleUnit = (width/2 - padding) / MAX_SCORE;

            // Draw title for strength comparison
            strengthCtx.font = 'bold 81px Arial';
            strengthCtx.textAlign = 'center';
            strengthCtx.fillStyle = 'black';
            strengthCtx.fillText('Bias Balance Comparison', width/2, 160);

            // Calculate bias strengths for each personality
            const biasStrengths = allPersonalityExplanations.map(personality => ({
                name: personality.personality,
                biases: personality.scored_biases.map(bias => ({
                    type: bias.bias_type,
                    strength: Math.abs(bias.for_score - bias.against_score),
                    for_score: bias.for_score,
                    against_score: bias.against_score
                }))
            }));

            const barHeight = 60;
            const maxBarWidth = width - (padding * 2);
            const startY = 300;
            const startX = padding;

            // Draw strength bars for each bias type
            biasTypes.forEach((biasType, typeIndex) => {
                const y = startY + (typeIndex * (barHeight + 120));

                // Draw background rectangle for this bias group
                strengthCtx.fillStyle = typeIndex % 2 === 0 ? '#f0f0f0' : '#d8d8d8';
                strengthCtx.fillRect(centerLineX - (maxBarWidth/2), y - 20, maxBarWidth * 1.5, barHeight + 80);

                // Legend text
                strengthCtx.font = 'bold 72px Arial';
                strengthCtx.textAlign = 'right';
                strengthCtx.fillStyle = 'black';
                strengthCtx.fillText(biasType, centerLineX - (maxBarWidth/2) + 1200, y + barHeight + 20);

                // Draw bars for each personality
                biasStrengths.forEach((personality, pIndex) => {
                    const bias = personality.biases.find(b => b.type === biasType);
                    if (bias) {
                        const yOffset = pIndex * (barHeight + 20);

                        // Calculate bar dimensions for against and for scores
                        const againstWidth = bias.against_score * scaleUnit * 0.5;
                        const forWidth = bias.for_score * scaleUnit * 0.5;

                        strengthCtx.fillStyle = colors[pIndex];
                        // Draw against score bar (left side)
                        strengthCtx.fillRect(centerLineX - againstWidth, y + yOffset, againstWidth, barHeight/2);
                        // Draw for score bar (right side)
                        strengthCtx.fillRect(centerLineX, y + yOffset, forWidth, barHeight/2);

                        // Add scores on both sides
                        strengthCtx.fillStyle = 'black';

                        // Against score on left side
                        strengthCtx.textAlign = 'right';
                        strengthCtx.font = 'bold 60px Arial';
                        strengthCtx.fillText(`${bias.against_score}`,
                            centerLineX - againstWidth - 10, // 10px left of bar
                            y + yOffset + (barHeight/3));

                        // For score on right side
                        strengthCtx.textAlign = 'left';
                        strengthCtx.fillText(`${bias.for_score}`,
                            centerLineX + forWidth + 10, // 10px right of bar
                            y + yOffset + (barHeight/3));
                    }
                });
            });

            // Draw vertical center line
            strengthCtx.beginPath();
            strengthCtx.strokeStyle = '#000000'; // Solid black
            strengthCtx.lineWidth = 8; // Increased from 4px (100%)
            strengthCtx.moveTo(centerLineX, startY - 50);  // Start above first bar
            strengthCtx.lineTo(centerLineX, startY + (biasTypes.length - 1) * (barHeight + 120) + barHeight + 100);  // Added 100 more pixels at bottom
            strengthCtx.stroke();

            // Add legend at the bottom with clear separation
            const strengthLegendStartY = height - padding + 50; // Position legend below the diagram
            strengthCtx.font = 'bold 72px Arial';
            strengthCtx.textAlign = 'left';
            strengthCtx.fillStyle = 'black';
            strengthCtx.fillText('Legend:', padding, strengthLegendStartY);

            // Add strength explanation to the right of "Legend:"
            strengthCtx.font = 'bold 60px Arial';
            const legendTextX = padding + 300;
            strengthCtx.fillText('Values shown as: Balance (Against score, For score)', legendTextX, strengthLegendStartY);

            // Add personality colors next to the legend explanation
            biasStrengths.forEach((personality, index) => {
                const xPos = legendTextX + 1800 + (index * 600); // Increased from 1200 to 1800 and spacing from 400 to 600
                strengthCtx.fillStyle = colors[index];
                strengthCtx.beginPath();
                strengthCtx.arc(xPos, strengthLegendStartY - 20, 30, 0, 2 * Math.PI);
                strengthCtx.fill();
                strengthCtx.fillStyle = 'black';
                strengthCtx.textAlign = 'left';
                strengthCtx.font = 'bold 60px Arial';
                strengthCtx.fillText(personality.name, xPos + 50, strengthLegendStartY);
            });

            // Convert both canvases to buffers and combine them
            const buffer1 = canvas.toBuffer('image/png');
            const buffer2 = strengthCanvas.toBuffer('image/png');

            // Upload both images
            const imageId1 = await spaceModule.putImage(buffer1);
            const imageId2 = await spaceModule.putImage(buffer2);

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
                text: "Distribution of bias scores across personalities:",
                commands: {
                    image: {
                        id: imageId1
                    }
                }
            });

            await documentModule.addParagraph(this.spaceId, documentId, visualChapterId, {
                text: "Comparison of total bias strength:",
                commands: {
                    image: {
                        id: imageId2
                    }
                }
            });

            // Add chapters for each bias and personality
            for (const personalityExplanation of allPersonalityExplanations) {
                for (const bias of personalityExplanation.scored_biases) {
                    const chapterData = {
                        title: `${bias.bias_type} - ${personalityExplanation.personality} (Against: ${bias.against_score}, For: ${bias.for_score})`,
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