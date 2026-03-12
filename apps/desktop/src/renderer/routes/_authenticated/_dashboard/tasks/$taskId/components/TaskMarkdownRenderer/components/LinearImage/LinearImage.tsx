interface LinearImageProps {
	src?: string;
	alt?: string;
	title?: string;
}

/**
 * Image component that renders Linear and other image URLs directly.
 */
export function LinearImage({ src, alt, title }: LinearImageProps) {
	if (!src) {
		return null;
	}

	return (
		<img
			src={src}
			alt={alt}
			title={title}
			className="max-w-full h-auto rounded-md my-4"
		/>
	);
}
