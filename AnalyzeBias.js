export class AnalyzeBias {
    static async execute({
        personality,
        prompt,
        text,
        topBiases = 5
    }) {
        try {
            // Get the personality's LLM
            const llm = await assistOS.Personalities.getLLM(personality);
            if (!llm) {
                throw new Error('Failed to get LLM for personality');
            }

            // Analyze text for biases
            const biasResults = await this.detectBiases(llm, text, prompt, topBiases);

            // Generate visualization
            const visualization = await this.generateVisualization(biasResults);

            // Create AssistOS document
            const document = await assistOS.Document.create({
                title: 'Bias Analysis Report',
                content: await this.generateReport(biasResults, visualization)
            });

            return {
                success: true,
                documentId: document.id,
                biases: biasResults.biases
            };

        } catch (error) {
            console.error('Error in AnalyzeBias flow:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    static async detectBiases(llm, text, prompt, topBiases) {
        // Prepare the analysis prompt
        const analysisPrompt = this.prepareAnalysisPrompt(text, prompt, topBiases);

        // Get bias analysis from LLM
        const analysis = await llm.complete(analysisPrompt);

        // Parse and validate results
        return this.parseAnalysisResults(analysis, topBiases);
    }

    static prepareAnalysisPrompt(text, userPrompt, topBiases) {
        return `
            Analyze the following text for potential biases. For each bias:
            1. Identify the bias type and its counter-bias
            2. Score the bias strength (0-1)
            3. Assign it to a quadrant (1-4)
            4. Provide a detailed explanation
            
            Additional instructions: ${userPrompt || 'Focus on the most significant biases'}
            Number of biases to detect: ${topBiases}
            
            Text to analyze:
            ${text}
            
            Provide the analysis in the following JSON format:
            {
                "biases": [
                    {
                        "name": "bias name",
                        "counterBias": "counter-bias name",
                        "score": 0.0-1.0,
                        "quadrant": 1-4
                    }
                ],
                "explanations": [
                    "detailed explanation for each bias"
                ]
            }
        `;
    }

    static parseAnalysisResults(analysis, topBiases) {
        try {
            const results = JSON.parse(analysis);
            
            // Validate and normalize results
            results.biases = results.biases
                .slice(0, topBiases)
                .map(bias => ({
                    ...bias,
                    score: Math.max(0, Math.min(1, bias.score)),
                    quadrant: Math.max(1, Math.min(4, bias.quadrant))
                }));

            return results;

        } catch (error) {
            throw new Error('Failed to parse bias analysis results');
        }
    }

    static async generateVisualization(biasResults) {
        // Generate SVG visualization
        const width = 800;
        const height = 600;
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.min(width, height) * 0.4;

        let svg = `
            <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5"
                        markerWidth="6" markerHeight="6"
                        orient="auto-start-reverse">
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="#999"/>
                    </marker>
                </defs>
                
                <!-- Quadrant lines -->
                <line x1="${centerX}" y1="0" x2="${centerX}" y2="${height}" 
                    stroke="#ddd" stroke-width="1"/>
                <line x1="0" y1="${centerY}" x2="${width}" y2="${centerY}" 
                    stroke="#ddd" stroke-width="1"/>
                
                <!-- Axes -->
                <line x1="0" y1="${centerY}" x2="${width}" y2="${centerY}" 
                    stroke="#999" stroke-width="2" marker-end="url(#arrow)"/>
                <line x1="${centerX}" y1="${height}" x2="${centerX}" y2="0" 
                    stroke="#999" stroke-width="2" marker-end="url(#arrow)"/>
        `;

        // Add bias points and labels
        biasResults.biases.forEach(bias => {
            const angle = (bias.quadrant - 1) * Math.PI / 2;
            const x = centerX + Math.cos(angle) * radius * bias.score;
            const y = centerY - Math.sin(angle) * radius * bias.score;

            svg += `
                <circle cx="${x}" cy="${y}" r="5" fill="#007bff"/>
                <text x="${x + 10}" y="${y + 5}" font-size="10" fill="#333">
                    ${bias.name}
                </text>
            `;
        });

        svg += '</svg>';
        return svg;
    }

    static async generateReport(biasResults, visualization) {
        return {
            chapters: [
                {
                    title: 'Bias Visualization',
                    content: visualization
                },
                {
                    title: 'Detected Biases',
                    content: this.formatBiasesList(biasResults.biases)
                },
                {
                    title: 'Detailed Analysis',
                    content: this.formatExplanations(biasResults)
                }
            ]
        };
    }

    static formatBiasesList(biases) {
        return biases.map(bias => `
            ## ${bias.name}
            - Score: ${(bias.score * 100).toFixed(1)}%
            - Counter-bias: ${bias.counterBias}
            - Quadrant: ${bias.quadrant}
        `).join('\n\n');
    }

    static formatExplanations(results) {
        return results.biases.map((bias, index) => `
            ## ${bias.name}
            ${results.explanations[index]}
        `).join('\n\n');
    }
} 