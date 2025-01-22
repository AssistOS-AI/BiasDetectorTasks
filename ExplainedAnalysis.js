module.exports = {
    runTask: async function () {
        try {
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

            // Extract original text from first chapter
            const originalText = sourceDoc.chapters[0]?.paragraphs[0]?.text;
            if (!originalText) {
                throw new Error('Original text not found in source document');
            }

            // Extract bias pairs from chapters
            let biasPairs = [];
            for (let i = 1; i < sourceDoc.chapters.length; i++) {
                const chapter = sourceDoc.chapters[i];
                const titleMatch = chapter.title.match(/(.+?)\s*\(Positive:\s*(\{.*?\}),\s*Negative:\s*(\{.*?\})\)/);
                
                if (titleMatch) {
                    const biasType = titleMatch[1].trim();
                    const positiveScore = JSON.parse(titleMatch[2]);
                    const negativeScore = JSON.parse(titleMatch[3]);
                    const positiveExplanation = chapter.paragraphs[0]?.text || '';
                    const negativeExplanation = chapter.paragraphs[1]?.text || '';

                    biasPairs.push({
                        bias_type: biasType,
                        positive: {
                            score: positiveScore,
                            explanation: positiveExplanation
                        },
                        negative: {
                            score: negativeScore,
                            explanation: negativeExplanation
                        }
                    });
                }
            }

            // Generate detailed explanations for each bias
            this.logProgress("Generating detailed explanations...");
            const explanationPrompt = `
            As ${personalityObj.name}, analyze the following text and explain the bias scores in detail:

            Original Text:
            ${originalText}

            For each bias pair, explain:
            1. Why these specific scores were chosen
            2. Find and quote relevant parts of the text that demonstrate this bias
            3. Analyze how the bias manifests in both positive and negative ways
            4. Explain the impact of this bias on the reader's understanding

            Bias Pairs to analyze:
            ${JSON.stringify(biasPairs, null, 2)}

            Format your response as a JSON object with this structure:
            {
                "detailed_explanations": [
                    {
                        "bias_type": "name of bias",
                        "score_explanation": "detailed explanation of why these scores were chosen",
                        "supporting_quotes": ["quote 1", "quote 2"],
                        "positive_analysis": "detailed analysis of positive manifestation",
                        "negative_analysis": "detailed analysis of negative manifestation",
                        "impact_analysis": "analysis of the bias impact"
                    }
                ]
            }`;

            const response = await llmModule.generateText(this.spaceId, explanationPrompt, personalityObj);
            const explanations = JSON.parse(response.message);

            // Create visualization chapter
            const chapters = [];
            
            // Add diagram chapter
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = 1200;
            tempCanvas.height = 1000;
            const ctx = tempCanvas.getContext('2d');

            // Draw the visualization
            const width = tempCanvas.width;
            const height = tempCanvas.height;
            const centerX = width / 2;
            const centerY = height / 2;
            const padding = 80;

            // Set up scale
            const maxValue = 10;
            const scale = (Math.min(width, height) - 2 * padding) / (2 * maxValue);

            // Clear canvas with white background
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, width, height);

            // Draw grid lines
            ctx.strokeStyle = '#EEEEEE';
            ctx.lineWidth = 1;
            for (let i = -maxValue; i <= maxValue; i++) {
                // Vertical grid line
                const x = centerX + i * scale;
                ctx.beginPath();
                ctx.moveTo(x, padding);
                ctx.lineTo(x, height - padding);
                ctx.stroke();

                // Horizontal grid line
                const y = centerY - i * scale;
                ctx.beginPath();
                ctx.moveTo(padding, y);
                ctx.lineTo(width - padding, y);
                ctx.stroke();
            }

            // Draw axes
            ctx.strokeStyle = '#CCCCCC';
            ctx.lineWidth = 1;

            // X-axis
            ctx.beginPath();
            ctx.moveTo(padding, centerY);
            ctx.lineTo(width - padding, centerY);
            ctx.stroke();

            // Y-axis
            ctx.beginPath();
            ctx.moveTo(centerX, padding);
            ctx.lineTo(centerX, height - padding);
            ctx.stroke();

            // Add axis labels
            ctx.fillStyle = '#666666';
            ctx.font = '28px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            // X-axis labels (only -10, -5, 5, 10)
            const labelValues = [-10, -5, 5, 10];
            labelValues.forEach(value => {
                const x = centerX + value * scale;
                ctx.fillText(value.toString(), x, centerY + 35);
            });

            // Y-axis labels (only -10, -5, 5, 10)
            labelValues.forEach(value => {
                const y = centerY - value * scale;
                ctx.fillText(value.toString(), centerX - 35, y);
            });

            // Add single 0 at center
            ctx.fillText('0', centerX - 35, centerY + 35);

            // Plot data points and connecting lines
            const colors = ['#FF0000', '#FFA500', '#FFD700', '#32CD32', '#4169E1', '#8A2BE2', '#FF69B4'];
            biasPairs.forEach((pair, index) => {
                // Get color for this pair (cycle through colors if more pairs than colors)
                const color = colors[index % colors.length];

                // Draw connecting line first (so it's behind points)
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                const x1 = centerX + pair.positive.score.x * scale;
                const y1 = centerY - pair.positive.score.y * scale;
                const x2 = centerX + pair.negative.score.x * scale;
                const y2 = centerY - pair.negative.score.y * scale;
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();

                // Plot points on top of line
                ctx.fillStyle = '#000000';
                // Plot positive bias
                ctx.beginPath();
                ctx.arc(x1, y1, 10, 0, 2 * Math.PI);
                ctx.fill();

                // Plot negative bias
                ctx.beginPath();
                ctx.arc(x2, y2, 10, 0, 2 * Math.PI);
                ctx.fill();
            });

            // Convert canvas to binary data
            const blob = await new Promise(resolve => tempCanvas.toBlob(resolve, 'image/png'));
            const arrayBuffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            
            const imageId = await spaceModule.putImage(uint8Array);
            
            chapters.push({
                title: "Bias Score Visualization",
                content: "",
                commands: {
                    image: {
                        id: imageId,
                        width: tempCanvas.width,
                        height: tempCanvas.height
                    }
                }
            });

            // Add detailed explanation chapters
            explanations.detailed_explanations.forEach((explanation, index) => {
                const biasPair = biasPairs[index];
                chapters.push({
                    title: explanation.bias_type,
                    content: "",
                    paragraphs: [
                        {
                            text: `Score Analysis:\n${explanation.score_explanation}`,
                            commands: {}
                        },
                        {
                            text: "Supporting Quotes:\n" + explanation.supporting_quotes.join("\n\n"),
                            commands: {}
                        },
                        {
                            text: `Positive Manifestation:\n${explanation.positive_analysis}`,
                            commands: {}
                        },
                        {
                            text: `Negative Manifestation:\n${explanation.negative_analysis}`,
                            commands: {}
                        },
                        {
                            text: `Impact Analysis:\n${explanation.impact_analysis}`,
                            commands: {}
                        }
                    ]
                });
            });

            // Create and save the document
            const documentObj = {
                title: `bias_explained_${new Date().toISOString()}`,
                type: 'bias_explained',
                content: JSON.stringify(chapters, null, 2),
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

            // Add chapters and paragraphs
            for (const chapter of chapters) {
                const chapterData = {
                    title: chapter.title,
                    idea: `Detailed analysis of ${chapter.title}`
                };

                const chapterId = await documentModule.addChapter(this.spaceId, documentId, chapterData);

                if (chapter.paragraphs) {
                    for (const paragraph of chapter.paragraphs) {
                        await documentModule.addParagraph(this.spaceId, documentId, chapterId, paragraph);
                    }
                } else {
                    await documentModule.addParagraph(this.spaceId, documentId, chapterId, {
                        text: chapter.content,
                        commands: chapter.commands || {}
                    });
                }
            }

            return {
                status: 'completed',
                documentId: documentId
            };

        } catch (error) {
            this.logError(`Error in bias explanation: ${error.message}`);
            throw error;
        }
    }
}; 