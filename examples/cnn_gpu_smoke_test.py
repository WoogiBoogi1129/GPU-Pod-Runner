"""
Small PyTorch CNN smoke test for GPU Pod Runner.

- Uses only PyTorch, so no torchvision download is required.
- Generates a synthetic image dataset in memory.
- Triggers GPU detection through `torch.cuda.*` usage.
- Falls back to CPU if CUDA is not available, but is intended to run on a GPU Pod.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset, random_split


SEED = 7
IMAGE_SIZE = 32
NUM_CLASSES = 4
TRAIN_SAMPLES = 1024
EVAL_SAMPLES = 256
BATCH_SIZE = 64
EPOCHS = 4


def seed_everything(seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


class SyntheticPatternDataset(Dataset[tuple[torch.Tensor, int]]):
    def __init__(self, size: int) -> None:
        self.size = size

    def __len__(self) -> int:
        return self.size

    def __getitem__(self, index: int) -> tuple[torch.Tensor, int]:
        label = index % NUM_CLASSES
        image = torch.zeros(1, IMAGE_SIZE, IMAGE_SIZE, dtype=torch.float32)

        if label == 0:
            image[:, IMAGE_SIZE // 2 - 2 : IMAGE_SIZE // 2 + 2, :] = 1.0
        elif label == 1:
            image[:, :, IMAGE_SIZE // 2 - 2 : IMAGE_SIZE // 2 + 2] = 1.0
        elif label == 2:
            for i in range(IMAGE_SIZE):
                image[:, i, i] = 1.0
                if i + 1 < IMAGE_SIZE:
                    image[:, i, i + 1] = 1.0
        else:
            block_start = IMAGE_SIZE // 4
            block_end = block_start + IMAGE_SIZE // 2
            image[:, block_start:block_end, block_start:block_end] = 1.0

        image += 0.15 * torch.randn_like(image)
        image = image.clamp(0.0, 1.0)
        return image, label


class TinyCNN(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 16, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(16, 32, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(32, 64, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d((1, 1)),
        )
        self.classifier = nn.Linear(64, NUM_CLASSES)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.features(x)
        x = x.view(x.size(0), -1)
        return self.classifier(x)


@dataclass
class EpochStats:
    loss: float
    accuracy: float


def train_one_epoch(
    model: nn.Module,
    loader: DataLoader[tuple[torch.Tensor, int]],
    optimizer: torch.optim.Optimizer,
    criterion: nn.Module,
    device: torch.device,
) -> EpochStats:
    model.train()
    total_loss = 0.0
    total_correct = 0
    total_count = 0

    for images, labels in loader:
        images = images.to(device)
        labels = labels.to(device)

        optimizer.zero_grad()
        logits = model(images)
        loss = criterion(logits, labels)
        loss.backward()
        optimizer.step()

        total_loss += loss.item() * labels.size(0)
        total_correct += (logits.argmax(dim=1) == labels).sum().item()
        total_count += labels.size(0)

    return EpochStats(
        loss=total_loss / total_count,
        accuracy=total_correct / total_count,
    )


@torch.no_grad()
def evaluate(
    model: nn.Module,
    loader: DataLoader[tuple[torch.Tensor, int]],
    criterion: nn.Module,
    device: torch.device,
) -> EpochStats:
    model.eval()
    total_loss = 0.0
    total_correct = 0
    total_count = 0

    for images, labels in loader:
        images = images.to(device)
        labels = labels.to(device)

        logits = model(images)
        loss = criterion(logits, labels)

        total_loss += loss.item() * labels.size(0)
        total_correct += (logits.argmax(dim=1) == labels).sum().item()
        total_count += labels.size(0)

    return EpochStats(
        loss=total_loss / total_count,
        accuracy=total_correct / total_count,
    )


def main() -> None:
    seed_everything(SEED)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Selected device: {device}")
    if torch.cuda.is_available():
        print(f"CUDA device count: {torch.cuda.device_count()}")
        print(f"CUDA device name: {torch.cuda.get_device_name(0)}")
    else:
        print("CUDA is unavailable. Running on CPU fallback.")

    dataset = SyntheticPatternDataset(TRAIN_SAMPLES + EVAL_SAMPLES)
    train_dataset, eval_dataset = random_split(
        dataset,
        [TRAIN_SAMPLES, EVAL_SAMPLES],
        generator=torch.Generator().manual_seed(SEED),
    )

    train_loader = DataLoader(train_dataset, batch_size=BATCH_SIZE, shuffle=True)
    eval_loader = DataLoader(eval_dataset, batch_size=BATCH_SIZE, shuffle=False)

    model = TinyCNN().to(device)
    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)

    print("Starting training...")
    for epoch in range(1, EPOCHS + 1):
        train_stats = train_one_epoch(model, train_loader, optimizer, criterion, device)
        eval_stats = evaluate(model, eval_loader, criterion, device)
        print(
            f"Epoch {epoch}/{EPOCHS} | "
            f"train_loss={train_stats.loss:.4f} train_acc={train_stats.accuracy:.3f} | "
            f"eval_loss={eval_stats.loss:.4f} eval_acc={eval_stats.accuracy:.3f}"
        )

    sample_batch, sample_labels = next(iter(eval_loader))
    sample_batch = sample_batch.to(device)
    logits = model(sample_batch)
    predictions = logits.argmax(dim=1).cpu()

    print("Sample predictions:")
    for idx in range(8):
        print(
            f"  sample={idx:02d} label={int(sample_labels[idx])} "
            f"pred={int(predictions[idx])}"
        )

    print("Smoke test finished successfully.")


if __name__ == "__main__":
    main()
