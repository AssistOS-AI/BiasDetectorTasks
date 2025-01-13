export class EditBias {
    static async execute({
        personality,
        documentId,
        biasIndex,
        editedBias,
        editedExplanation
    }) {
        try {
            // Get the original document
            const document = await assistOS.Document.get(documentId);
            if (!document) {
                throw new Error('Document not found');
            }

            // Get the personality's LLM
            const llm = await assistOS.Personalities.getLLM(personality);
            if (!llm) {
                throw new Error('Failed to get LLM for personality');
            }

            // Validate the edited bias
            const validatedBias = await this.validateBiasEdit(llm, editedBias, editedExplanation);

            // Update the document content
            const updatedContent = await this.updateDocumentContent(
                document.content,
                biasIndex,
                validatedBias,
                editedExplanation
            );

            // Save the updated document
            await assistOS.Document.update(documentId, {
                content: updatedContent
            });

            return {
                success: true,
                updatedBias: validatedBias
            };

        } catch (error) {
            console.error('Error in EditBias flow:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    static async validateBiasEdit(llm, editedBias, explanation) {
        const prompt = `
            Validate and normalize the following bias analysis:
            
            Bias: ${editedBias.name}
            Counter-bias: ${editedBias.counterBias}
            Score: ${editedBias.score}
            Quadrant: ${editedBias.quadrant}
            
            Explanation: ${explanation}
            
            Please validate:
            1. The bias and counter-bias are logically opposed
            2. The score is between 0 and 1
            3. The quadrant is between 1 and 4
            4. The explanation is consistent with the bias
            
            Return the validated bias in JSON format:
            {
                "name": "validated bias name",
                "counterBias": "validated counter-bias",
                "score": normalized score (0-1),
                "quadrant": normalized quadrant (1-4),
                "isValid": true/false,
                "validationMessage": "explanation if invalid"
            }
        `;

        const validation = await llm.complete(prompt);
        const result = JSON.parse(validation);

        if (!result.isValid) {
            throw new Error(`Invalid bias edit: ${result.validationMessage}`);
        }

        return {
            name: result.name,
            counterBias: result.counterBias,
            score: result.score,
            quadrant: result.quadrant
        };
    }

    static async updateDocumentContent(content, biasIndex, validatedBias, explanation) {
        // Deep clone the content to avoid mutations
        const updatedContent = JSON.parse(JSON.stringify(content));
        
        // Update the visualization chapter
        await this.updateVisualization(updatedContent.chapters[0], biasIndex, validatedBias);
        
        // Update the biases list chapter
        this.updateBiasesList(updatedContent.chapters[1], biasIndex, validatedBias);
        
        // Update the detailed analysis chapter
        this.updateExplanation(updatedContent.chapters[2], biasIndex, validatedBias, explanation);

        return updatedContent;
    }

    static async updateVisualization(chapter, biasIndex, bias) {
        // Parse the SVG content
        const parser = new DOMParser();
        const svg = parser.parseFromString(chapter.content, 'image/svg+xml');
        
        // Update the bias point and label
        const points = svg.querySelectorAll('circle');
        const labels = svg.querySelectorAll('text');
        
        if (points[biasIndex] && labels[biasIndex]) {
            const width = parseInt(svg.documentElement.getAttribute('width'));
            const height = parseInt(svg.documentElement.getAttribute('height'));
            const centerX = width / 2;
            const centerY = height / 2;
            const radius = Math.min(width, height) * 0.4;

            const angle = (bias.quadrant - 1) * Math.PI / 2;
            const x = centerX + Math.cos(angle) * radius * bias.score;
            const y = centerY - Math.sin(angle) * radius * bias.score;

            points[biasIndex].setAttribute('cx', x);
            points[biasIndex].setAttribute('cy', y);
            
            labels[biasIndex].setAttribute('x', x + 10);
            labels[biasIndex].setAttribute('y', y + 5);
            labels[biasIndex].textContent = bias.name;
        }

        chapter.content = svg.documentElement.outerHTML;
    }

    static updateBiasesList(chapter, biasIndex, bias) {
        const lines = chapter.content.split('\n');
        const biasStartIndex = this.findBiasSection(lines, biasIndex);
        
        if (biasStartIndex >= 0) {
            lines[biasStartIndex] = `## ${bias.name}`;
            lines[biasStartIndex + 1] = `- Score: ${(bias.score * 100).toFixed(1)}%`;
            lines[biasStartIndex + 2] = `- Counter-bias: ${bias.counterBias}`;
            lines[biasStartIndex + 3] = `- Quadrant: ${bias.quadrant}`;
        }

        chapter.content = lines.join('\n');
    }

    static updateExplanation(chapter, biasIndex, bias, explanation) {
        const lines = chapter.content.split('\n');
        const explanationStartIndex = this.findBiasSection(lines, biasIndex);
        
        if (explanationStartIndex >= 0) {
            lines[explanationStartIndex] = `## ${bias.name}`;
            lines[explanationStartIndex + 1] = explanation;
        }

        chapter.content = lines.join('\n');
    }

    static findBiasSection(lines, biasIndex) {
        let currentBias = -1;
        
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('## ')) {
                currentBias++;
                if (currentBias === biasIndex) {
                    return i;
                }
            }
        }

        return -1;
    }
} 