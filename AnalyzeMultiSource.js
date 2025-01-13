export class AnalyzeMultiSource {
    static async execute({
        personality,
        sources,
        topBiases = 5
    }) {
        try {
            // Get the personality's LLM
            const llm = await assistOS.Personalities.getLLM(personality);
            if (!llm) {
                throw new Error('Failed to get LLM for personality');
            }

            // Analyze each source
            const analysisResults = await Promise.all(
                sources.map(source => this.analyzeSource(llm, source, topBiases))
            );

            // Generate comparative visualization
            const visualization = await this.generateComparativeVisualization(analysisResults, sources);

            // Create AssistOS document
            const document = await assistOS.Document.create({
                title: 'Comparative Bias Analysis Report',
                content: await this.generateReport(analysisResults, visualization, sources)
            });

            return {
                success: true,
                documentId: document.id,
                results: analysisResults
            };

        } catch (error) {
            console.error('Error in AnalyzeMultiSource flow:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    static async analyzeSource(llm, source, topBiases) {
        const prompt = `
            Analyze the following text for potential biases. For each bias:
            1. Identify the bias type and its counter-bias
            2. Score the bias strength (0-1)
            3. Assign it to a quadrant (1-4)
            4. Provide a detailed explanation
            
            Number of biases to detect: ${topBiases}
            
            Text to analyze:
            ${source.text}
            
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

        const analysis = await llm.complete(prompt);
        return this.parseAnalysisResults(analysis, topBiases);
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

    static async generateComparativeVisualization(analysisResults, sources) {
        const width = 800;
        const height = 600;
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.min(width, height) * 0.4;

        // Generate unique colors for each source
        const colors = this.generateColors(sources.length);

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
                
                <!-- Legend -->
                <g transform="translate(10, 10)">
                    ${sources.map((source, i) => `
                        <g transform="translate(0, ${i * 20})">
                            <circle cx="5" cy="5" r="5" fill="${colors[i]}"/>
                            <text x="15" y="9" font-size="12">${source.name}</text>
                        </g>
                    `).join('')}
                </g>
        `;

        // Add bias points for each source
        analysisResults.forEach((result, sourceIndex) => {
            result.biases.forEach(bias => {
                const angle = (bias.quadrant - 1) * Math.PI / 2;
                const x = centerX + Math.cos(angle) * radius * bias.score;
                const y = centerY - Math.sin(angle) * radius * bias.score;

                svg += `
                    <circle cx="${x}" cy="${y}" r="5" fill="${colors[sourceIndex]}"/>
                    <text x="${x + 10}" y="${y + 5}" font-size="10" fill="#333">
                        ${bias.name}
                    </text>
                `;
            });
        });

        svg += '</svg>';
        return svg;
    }

    static generateColors(count) {
        const colors = [];
        for (let i = 0; i < count; i++) {
            const hue = (i * 360 / count) % 360;
            colors.push(`hsl(${hue}, 70%, 50%)`);
        }
        return colors;
    }

    static async generateReport(analysisResults, visualization, sources) {
        return {
            chapters: [
                {
                    title: 'Comparative Bias Visualization',
                    content: visualization
                },
                {
                    title: 'Source Analysis',
                    content: this.formatSourceAnalysis(analysisResults, sources)
                },
                {
                    title: 'Comparative Analysis',
                    content: this.formatComparativeAnalysis(analysisResults, sources)
                }
            ]
        };
    }

    static formatSourceAnalysis(analysisResults, sources) {
        return sources.map((source, index) => `
            # ${source.name}
            
            ${this.formatBiasesList(analysisResults[index].biases)}
            
            ## Detailed Analysis
            ${this.formatExplanations(analysisResults[index])}
        `).join('\n\n---\n\n');
    }

    static formatComparativeAnalysis(analysisResults, sources) {
        // Group similar biases across sources
        const biasGroups = this.groupSimilarBiases(analysisResults);
        
        return Object.entries(biasGroups).map(([biasType, sourceBiases]) => `
            # ${biasType}
            
            ${sources.map((source, index) => {
                const bias = sourceBiases[index];
                if (!bias) return `${source.name}: Not detected`;
                return `${source.name}: Score ${(bias.score * 100).toFixed(1)}%`;
            }).join('\n')}
        `).join('\n\n');
    }

    static groupSimilarBiases(analysisResults) {
        const groups = {};
        
        analysisResults.forEach((result, sourceIndex) => {
            result.biases.forEach(bias => {
                if (!groups[bias.name]) {
                    groups[bias.name] = new Array(analysisResults.length).fill(null);
                }
                groups[bias.name][sourceIndex] = bias;
            });
        });

        return groups;
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